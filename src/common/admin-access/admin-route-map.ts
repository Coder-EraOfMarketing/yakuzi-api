import { AccessLevel, TabKey } from './admin-access.types';

/**
 * Maps an admin-gated request to the tab and level it needs.
 *
 * Deliberately a single table rather than a decorator on each of the ~200
 * admin handlers: a decorator that someone forgets to add on a new route is an
 * open door, whereas a route missing from this table is DENIED for restricted
 * admins (see resolveAdminRoute's fallthrough) and shows up the first time
 * anyone uses it. Only routes that require the ADMIN role ever reach here -
 * the guard skips anything a buyer or seller can also call, so public product
 * and category reads used by pickers inside the panel are never blocked.
 *
 * Rules are evaluated in order and the first match wins, so the risky-action
 * rules (which demand `full`) are listed above the general tab rules they
 * would otherwise fall into.
 */

export type RouteRequirement =
  | { kind: 'allow' }
  | { kind: 'super' }
  | { kind: 'anyWrite' }
  | { kind: 'tab'; tab: TabKey; required: AccessLevel }
  | { kind: 'deny' };

interface RouteRule {
  pattern: RegExp;
  /** Restricts the rule to these methods; omitted means any method. */
  methods?: string[];
  tab?: TabKey;
  /** Level demanded for non-read methods. Reads always need `view`. */
  writeLevel?: AccessLevel;
  allowAll?: boolean;
  superOnly?: boolean;
  anyWrite?: boolean;
}

const READ_METHODS = ['GET', 'HEAD', 'OPTIONS'];
const WRITE = ['POST', 'PATCH', 'PUT', 'DELETE'];

const RULES: RouteRule[] = [
  // ── Always available to any admin ────────────────────────────────────────
  // The dashboard is the landing page, and its analytics widgets come from
  // /admin/analytics; blocking either would leave a restricted admin staring
  // at an error the moment they log in.
  { pattern: /^\/admin\/?$/, allowAll: true },
  { pattern: /^\/admin\/dashboard(\/|$)/, allowAll: true },
  { pattern: /^\/admin\/analytics(\/|$)/, allowAll: true },
  { pattern: /^\/admin\/notifications\/broadcasts\/me$/, allowAll: true },

  // Uploads are a shared utility behind half the tabs (product images, banner
  // art, blog covers). Gate them on "can write somewhere" rather than on any
  // one tab, or a content editor cannot upload a banner.
  { pattern: /^\/storage(\/|$)/, anyWrite: true },

  // ── Super Admin only ─────────────────────────────────────────────────────
  // Granting access is itself a super-admin power (the service layer repeats
  // this check, so it holds even if a route is ever mounted elsewhere).
  { pattern: /^\/admin\/admins(\/|$)/, superOnly: true },
  // Bulk import/rollback of live data.
  { pattern: /^\/migration(\/|$)/, superOnly: true },

  // ── Customers ────────────────────────────────────────────────────────────
  {
    pattern: /^\/admin\/users\/[^/]+\/(approve|reject|block|unblock)$/,
    tab: 'users',
    writeLevel: 'full',
  },
  { pattern: /^\/admin\/users\/[^/]+$/, methods: ['DELETE'], tab: 'users', writeLevel: 'full' },
  { pattern: /^\/admin\/users(\/|$)/, tab: 'users' },
  { pattern: /^\/buyers\/all$/, tab: 'users' },
  { pattern: /^\/admin\/buyers\/[^/]+\/gst-pan-status$/, tab: 'users', writeLevel: 'full' },
  // Self Ship is its own tab; every other seller-level admin action is Users.
  { pattern: /^\/admin\/sellers\/[^/]+\/self-ship$/, tab: 'selfShip' },
  { pattern: /^\/admin\/sellers\/[^/]+\/gst-pan-status$/, tab: 'users', writeLevel: 'full' },
  { pattern: /^\/admin\/sellers(\/|$)/, tab: 'users' },

  { pattern: /^\/reviews\/admin(\/|$)/, methods: ['DELETE'], tab: 'reviews', writeLevel: 'full' },
  { pattern: /^\/reviews\/admin(\/|$)/, tab: 'reviews' },

  { pattern: /^\/admin\/tickets(\/|$)/, tab: 'tickets' },

  // ── Catalog ──────────────────────────────────────────────────────────────
  {
    pattern: /^\/admin\/products\/[^/]+\/(approve|reject)$/,
    tab: 'products',
    writeLevel: 'full',
  },
  { pattern: /^\/admin\/products(\/|$)/, methods: ['DELETE'], tab: 'products', writeLevel: 'full' },
  { pattern: /^\/admin\/products(\/|$)/, tab: 'products' },
  { pattern: /^\/products\/requests(\/|$)/, tab: 'products' },

  { pattern: /^\/brands(\/|$)/, methods: ['DELETE'], tab: 'brands', writeLevel: 'full' },
  { pattern: /^\/brands(\/|$)/, tab: 'brands' },

  {
    pattern: /^\/admin\/(categories|subcategories)\/bulk$/,
    tab: 'categories',
    writeLevel: 'full',
  },
  {
    pattern: /^\/admin\/(categories|subcategories)(\/|$)/,
    methods: ['DELETE'],
    tab: 'categories',
    writeLevel: 'full',
  },
  { pattern: /^\/admin\/(categories|subcategories)(\/|$)/, tab: 'categories' },

  { pattern: /^\/admin\/suggestions\/import$/, tab: 'suggestions', writeLevel: 'full' },
  {
    pattern: /^\/admin\/suggestions(\/|$)/,
    methods: ['DELETE'],
    tab: 'suggestions',
    writeLevel: 'full',
  },
  { pattern: /^\/admin\/suggestions(\/|$)/, tab: 'suggestions' },

  // ── Orders, shipping and payments ────────────────────────────────────────
  { pattern: /^\/admin\/orders\/cancel-test-orders$/, tab: 'orders', writeLevel: 'full' },
  { pattern: /^\/orders\/[^/]+\/cancel$/, tab: 'orders', writeLevel: 'full' },
  // Confirming or rejecting a payment moves money; that is a full-edit action
  // even though it is reached from the ordinary Orders screen.
  { pattern: /^\/(admin\/)?payments\/[^/]+\/(confirm|reject)$/, tab: 'orders', writeLevel: 'full' },
  { pattern: /^\/admin\/payments(\/|$)/, tab: 'orders' },
  { pattern: /^\/admin\/orders(\/|$)/, tab: 'orders' },
  { pattern: /^\/orders(\/|$)/, tab: 'orders' },
  { pattern: /^\/custom-orders(\/|$)/, tab: 'orders' },

  // ── Money ────────────────────────────────────────────────────────────────
  { pattern: /^\/admin\/settlements\/[^/]+\/mark-paid$/, tab: 'settlements', writeLevel: 'full' },
  { pattern: /^\/admin\/settlements(\/|$)/, tab: 'settlements' },

  // ── Content & marketing ──────────────────────────────────────────────────
  { pattern: /^\/banners(\/|$)/, methods: ['DELETE'], tab: 'banners', writeLevel: 'full' },
  { pattern: /^\/banners(\/|$)/, tab: 'banners' },

  {
    pattern: /^\/homepage-sections(\/|$)/,
    methods: ['DELETE'],
    tab: 'homepageSections',
    writeLevel: 'full',
  },
  { pattern: /^\/homepage-sections(\/|$)/, tab: 'homepageSections' },
  // The Instagram feed is configured from the Homepage Sections screen.
  { pattern: /^\/instagram(\/|$)/, tab: 'homepageSections' },

  { pattern: /^\/admin\/referrals(\/|$)/, methods: ['DELETE'], tab: 'marketing', writeLevel: 'full' },
  { pattern: /^\/admin\/referrals(\/|$)/, tab: 'marketing' },
  { pattern: /^\/admin\/marketing(\/|$)/, methods: ['DELETE'], tab: 'marketing', writeLevel: 'full' },
  { pattern: /^\/admin\/marketing(\/|$)/, tab: 'marketing' },

  // Publishing (or unpublishing) is what makes a post public - full edit.
  { pattern: /^\/admin\/blogs\/[^/]+\/status$/, tab: 'blogs', writeLevel: 'full' },
  { pattern: /^\/admin\/blogs(\/|$)/, methods: ['DELETE'], tab: 'blogs', writeLevel: 'full' },
  { pattern: /^\/admin\/blogs(\/|$)/, tab: 'blogs' },
  { pattern: /^\/blog(\/|$)/, methods: ['DELETE'], tab: 'blogs', writeLevel: 'full' },
  { pattern: /^\/blog(\/|$)/, tab: 'blogs' },

  // Redirects rewrite live URLs; meta edits are ordinary copy work.
  { pattern: /^\/admin\/seo\/redirects(\/|$)/, methods: WRITE, tab: 'seo', writeLevel: 'full' },
  { pattern: /^\/admin\/seo(\/|$)/, tab: 'seo' },

  { pattern: /^\/admin\/chatbot(\/|$)/, methods: ['DELETE'], tab: 'chatbot', writeLevel: 'full' },
  { pattern: /^\/admin\/chatbot(\/|$)/, tab: 'chatbot' },
  { pattern: /^\/chatbot(\/|$)/, tab: 'chatbot' },

  // A broadcast reaches every user at once.
  { pattern: /^\/admin\/notifications\/broadcast$/, tab: 'notifications', writeLevel: 'full' },
  { pattern: /^\/admin\/notifications(\/|$)/, tab: 'notifications' },

  // ── System ───────────────────────────────────────────────────────────────
  // System tabs have no "everyday" tier: reading is view, changing is full.
  { pattern: /^\/admin\/settings(\/|$)/, tab: 'settings', writeLevel: 'full' },
];

/**
 * Strips the global `api` prefix and any query string, and removes a trailing
 * slash, so rules can be written against the path as it appears in the
 * controllers.
 */
export function normalizeAdminPath(url: string): string {
  const path = (url || '').split('?')[0].replace(/\/+$/, '') || '/';
  const withoutPrefix = path.replace(/^\/api(?=\/|$)/, '');
  return withoutPrefix || '/';
}

export function resolveAdminRoute(method: string, url: string): RouteRequirement {
  const path = normalizeAdminPath(url);
  const upperMethod = (method || 'GET').toUpperCase();

  for (const rule of RULES) {
    if (rule.methods && !rule.methods.includes(upperMethod)) continue;
    if (!rule.pattern.test(path)) continue;

    if (rule.allowAll) return { kind: 'allow' };
    if (rule.superOnly) return { kind: 'super' };
    if (rule.anyWrite) return { kind: 'anyWrite' };
    if (!rule.tab) return { kind: 'deny' };

    const required: AccessLevel = READ_METHODS.includes(upperMethod)
      ? 'view'
      : (rule.writeLevel ?? 'partial');
    return { kind: 'tab', tab: rule.tab, required };
  }

  // Unmapped admin-only route. Super admins never reach this line, so the
  // conservative answer costs nothing today and surfaces the gap loudly the
  // first time a restricted admin needs a newly added endpoint.
  return { kind: 'deny' };
}
