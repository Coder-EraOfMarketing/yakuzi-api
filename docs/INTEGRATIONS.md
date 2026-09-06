# Integrations — Shopify, WooCommerce, Amazon SP-API

Sellers connect their existing sales channels and keep inventory aligned with
Yukizi. This document covers the architecture, the manual platform setup that
cannot be automated, and how to test locally.

---

## Architecture

Yukizi is the **central inventory system**. Channels never talk to each other:

```
  Shopify ─┐
WooCommerce ┼──▶  Yukizi inventory engine  ──▶ connected channels
   Amazon ─┘        (normalise → decide)
```

Every external change is normalised into an `InventoryEvent` before anything is
applied. That single choke point is what makes loops impossible by construction
rather than by luck — there is no code path where Shopify can update WooCommerce
directly.

### Loop prevention

The specific failure this avoids: Yukizi sets Shopify 5 → 4; Shopify sends a
webhook saying "inventory is now 4"; a naive system treats that as news and
pushes 4 to WooCommerce and Amazon, which each echo back, forever.

Two mechanisms:

| Mechanism | Where | What it stops |
|---|---|---|
| Unique index on `(sourcePlatform, sourceEventId)` | `inventory_events` | The same webhook delivered twice being applied twice. Enforced by Postgres, so it holds across concurrent app instances. |
| Echo detection against the last outbound write | `IntegrationWebhooksService.isEchoOfOurWrite` | An inbound event that merely confirms Yukizi's own update. Recorded with `skipReason: ECHO_OF_OUR_WRITE`, never re-broadcast. |

Events that cannot be matched to a listing are recorded with
`skipReason: NO_MAPPING` rather than dropped, so they surface as "requiring
attention" instead of vanishing.

### Credential security

- Channel credentials are encrypted at rest with **AES-256-GCM** and stored in
  `seller_integrations.encryptedCredentials`. GCM's auth tag means a tampered
  row fails to decrypt rather than yielding attacker-chosen values.
- If `INTEGRATIONS_ENCRYPTION_KEY` is absent, authorization flows **refuse to
  start**. There is no fallback that writes a plaintext token.
- `IntegrationsService.toSellerView()` is the only function that turns a row
  into a seller response, and it never references a credential column — so no
  future field addition can leak one by accident.
- Amazon access tokens are minted from the refresh token in memory and never
  persisted.

### Ownership

Every endpoint resolves the seller from the JWT. No route accepts a `sellerId`.
Cross-seller access returns **404, not 403** — a 403 would confirm the row
exists, which is an enumeration oracle.

### SSRF

WooCommerce is the one flow where the backend fetches a seller-supplied URL.
`store-url.util.ts` rejects loopback, RFC1918, link-local (including the
`169.254.169.254` cloud metadata address), CGNAT, IPv4-mapped IPv6, internal
suffixes, IP literals, credentials-in-URL, and non-standard ports — and
re-resolves the hostname immediately before each request to catch DNS rebinding.

---

## Manual platform configuration

These steps cannot be done from code and are required before the corresponding
card becomes usable. Until they are done, the UI shows the channel as
unavailable rather than offering a button that fails.

### Shopify (Partner Dashboard)

1. Create a **public app** at <https://partners.shopify.com> → Apps → Create app.
2. **App URL**: `https://seller.yukizi.com/integrations`
3. **Allowed redirection URL(s)** — must match `SHOPIFY_REDIRECT_URI` exactly:
   `https://yukizi.com/api/integrations/shopify/callback`
4. Copy the **Client ID** and **Client secret** into the env.
5. Scopes requested at runtime (no separate config needed):
   `read_products`, `read_inventory`, `write_inventory`, `read_locations`.
   No customer or order scopes are requested, so no protected-data approval is
   required.
6. For public distribution, submit the app for review. Until then it can be
   installed on development stores.

### WooCommerce (seller-side, no Yukizi config)

Nothing to register. Each seller's store generates its own key pair. Sellers
need:

- WordPress with WooCommerce active
- HTTPS with a valid certificate
- Pretty permalinks enabled (Settings → Permalinks → anything but "Plain")
- The REST API reachable (some security plugins, e.g. Wordfence, block
  non-browser agents and must allow Yukizi)
- An account with permission to create API keys

### Amazon (Solution Provider Portal)

1. Register as a developer in Seller Central → Apps & Services → Develop Apps.
2. Create an SP-API app. Roles needed for this feature:
   **Product Listing** (and **Inventory and Order Tracking** if FBA inventory
   display is wanted later). Do not request PII roles.
3. **OAuth Login URI**: `https://seller.yukizi.com/integrations`
   **OAuth Redirect URI**: `https://yukizi.com/api/integrations/amazon/callback`
4. Copy the LWA **Client ID**, **Client secret**, and the **App ID**
   (`amzn1.sp.solution.…`) into the env.
5. While the app is in **draft**, keep `AMAZON_SP_API_APP_DRAFT=true` — Amazon
   requires `version=beta` on the consent URL for draft apps. Set it to `false`
   only once the app is published, or published authorizations will fail.

---

## Local testing

Provider callbacks need a public HTTPS URL, so a tunnel is required:

```bash
# 1. Expose the local API
ngrok http 3000        # or: cloudflared tunnel --url http://localhost:3000

# 2. Point the env at the tunnel
API_PUBLIC_URL=https://<subdomain>.ngrok-free.app/api
SHOPIFY_REDIRECT_URI=https://<subdomain>.ngrok-free.app/api/integrations/shopify/callback
AMAZON_REDIRECT_URI=https://<subdomain>.ngrok-free.app/api/integrations/amazon/callback
SELLER_APP_URL=http://localhost:3003

# 3. Generate an encryption key
openssl rand -hex 32   # -> INTEGRATIONS_ENCRYPTION_KEY

# 4. Update the same redirect URIs in the Shopify/Amazon app settings.
```

Then:

```bash
npx prisma migrate deploy     # or: npx prisma db push
npm run start:dev             # API on :3000
cd ../yakuzi-web/apps/seller && npm run dev   # seller app on :3003
```

- **Shopify**: use a development store (free from the Partner Dashboard).
- **WooCommerce**: any public WordPress+Woo site. A LocalWP install will NOT
  work — the SSRF guard correctly refuses private addresses, and WooCommerce
  needs to reach the callback anyway.
- **Amazon**: SP-API has a sandbox, but OAuth consent requires a real Seller
  Central account.

Run the tests (no external credentials needed — the network is mocked):

```bash
npx jest src/modules/integrations
```

---

## Deployment

1. Set the env vars (see `.env.integrations.example`).
   `INTEGRATIONS_ENCRYPTION_KEY` must be **identical across all API instances**
   or one instance cannot decrypt what another wrote.
2. Ship the schema. `deploy-api.yml` already runs `prisma migrate deploy`; note
   the `start:prod` script also runs `prisma db push`. The migration is purely
   additive — it creates 7 tables and 11 enums and alters no existing table.
3. Register the production redirect URIs with Shopify and Amazon.
4. Verify: the Integrations page should show three cards, with a channel marked
   available only once its credentials are present.

### Key rotation

Changing `INTEGRATIONS_ENCRYPTION_KEY` makes existing credentials
undecryptable. The hourly health check detects this and flips affected
connections to **Action required**, prompting sellers to reconnect — it does not
fail silently. `credentialsKeyVersion` and the `v1.` envelope prefix exist so a
future re-wrapping migration can be written instead.

---

## Product import and SKU mapping (phase 2)

### The matching rule

In order, and nothing else:

1. **An existing mapping.** A mapping the seller made by hand is never
   overwritten by a later import.
2. **Exact SKU match** against the seller's own listings (`SellerOffer.sku`).
3. **Exact variant SKU match** (`ProductVariant.sku`).
4. **Otherwise, leave it for the seller.**

Comparison is case-insensitive and trims whitespace. **Product names are never
used.** Two products called "Naruto Figure" on two channels are not evidence
they are the same thing, and merging them silently would corrupt a seller's
stock in a way that is very hard to notice afterwards.

Where the answer is genuinely ambiguous the row becomes `CONFLICT` with a
reason, and Yukizi does not choose:

| `conflictReason` | Meaning |
|---|---|
| `SKU_MATCHES_MULTIPLE_PRODUCTS` | One channel SKU matches several Yukizi listings |
| `SKU_SHARED_BY_EXTERNAL_LISTINGS` | Several channel listings share one SKU |
| `NO_SKU` | The listing has no SKU at all (`MISSING_SKU`) |

### Inventory import

Quantities are pulled only for `MAPPED`, merchant-fulfilled rows. When Yukizi
and the channel disagree:

- If the seller made **that channel** the source of truth, the channel quantity
  is applied.
- Otherwise the difference is **flagged and nothing is written**. The seller
  resolves it per listing on the mapping screen ("Keep Yukizi 12" / "Use
  Shopify 7").

Stock is written through `InventoryService.updateDefaultBatch()` — the same path
the seller portal itself uses — so imported stock behaves identically to stock
typed into the UI, including low-stock alerts. Every write is recorded in
`inventory_events` as PENDING first and marked PROCESSED only after it lands, so
a crash halfway leaves an auditable row rather than a silent discrepancy.

**Amazon FBA is excluded from the write path entirely.** MFN and FBA
availability arrive as separate rows with different `fulfillmentChannel` values;
FBA quantities are imported for display and never treated as seller-controlled
stock.

### The job runner

`IntegrationJobRunnerService` runs every minute (`@Cron`), following the repo's
existing background-work pattern. Notable properties:

- Jobs are claimed by **compare-and-swap** (`updateMany` on `status: PENDING`),
  so two API instances cannot run the same job twice.
- A catalogue larger than one run's page budget (20 pages) **re-queues itself
  with a cursor**, so a large store makes steady progress instead of timing out.
- Requests are serial with a pause between pages. Bursting parallel requests at
  a seller's store is how integrations get rate-limited or firewalled.
- Retries back off quadratically (1m, 4m, 9m, …, capped at 30m). **429 is
  retried** — that is what backoff is for. **401/403 are permanent**: no number
  of attempts fixes a revoked token, and repeating it looks like an attack. The
  connection is flipped to *Action required* instead.
- Stored errors carry the HTTP status only, never a provider response body.

---

## Inventory export and the event engine (phase 3)

### How a change travels

1. A channel sends a webhook. The receiver verifies the signature and records
   an `InventoryEvent`.
2. `IntegrationEventsService` (every minute) claims the event with a
   compare-and-swap, applies it to Yukizi stock, and **fans out**: one
   `INVENTORY_PUSH` job per *other* channel carrying that listing.
3. The job runner writes the quantity to each of those channels.

The source channel is excluded from the fan-out, so an update travels outward
once and cannot return to where it came from.

### Loop prevention, end to end

Three independent guards, in the order they fire:

| Guard | Where | Stops |
|---|---|---|
| Unique `(sourcePlatform, sourceEventId)` | database | The same webhook applied twice |
| Outbound intent record | `IntegrationPushService` | The echo of our own write being treated as news |
| `QUANTITY_UNCHANGED` | `IntegrationEventsService` | Anything that would not change Yukizi's number fanning out |

The outbound record is written **before** the channel call, not after: if the
request succeeds but the response is lost, the echo is still recognised.

### What export refuses to write

- **Amazon FBA stock** — it lives in Amazon's fulfilment centres.
- **Any listing with an unresolved inventory difference** — the seller is being
  asked which number is right; writing would pre-empt them.
- **Import-only channels** — the seller declared those a read source.
- **A listing missing its provider handle** (Shopify inventory item, Amazon
  product type). That row is skipped with a reason; the rest of the batch still
  goes. `UnaddressableListingError` exists specifically so one incomplete
  listing cannot abort a whole batch.

### Webhook registration

Runs as a job when setup completes, and is idempotent — a re-run deletes what
it previously created rather than leaving duplicate subscriptions on the store.
Shopify subscribes to `inventory_levels/update` and `app/uninstalled`;
WooCommerce to `product.updated` and `product.deleted`, each with its own
generated signing secret stored encrypted.

Amazon registers nothing: SP-API notifications need an SQS destination Yukizi
does not operate, so that channel relies on the sweep.

### Reconciliation

Hourly, queueing any connection whose last successful sync is over 6 hours old,
capped per tick and never stacked on work already in flight. This is what
catches missed webhooks — and it is Amazon's only inbound path.

### Two-way sync

Enabled for **Shopify and WooCommerce**, which have signature-verified inbound
webhooks. **Amazon stays import- or export-only**: its inbound path is the
periodic sweep, which cannot distinguish an echo from a real change, so two-way
there would risk double-deduction. The UI mirrors this, and the API refuses it
regardless of what the UI offers.

---

## What is implemented, and what is not

**Phases 1–3 — complete and real:** everything above. Authorization for three
platforms, encrypted credentials, health checks, catalogue import, SKU matching,
inventory import and export, the event ledger with loop protection, webhook
registration and verification, the job runner, and reconciliation.

**Not implemented (phase 4):** order import and price synchronization. Both are
marked **Coming soon** in the UI, with columns reserved (`syncOrders`,
`syncPrices`) that no job reads.

Also deliberately absent: Amazon SP-API Notifications (needs an SQS
destination), and the Feeds API for bulk Amazon updates — the Listings Items
PATCH is used per listing, which is correct at current catalogue sizes and can
be swapped for Feeds without touching the mapping model.
