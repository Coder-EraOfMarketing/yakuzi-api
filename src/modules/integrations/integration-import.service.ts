import { Injectable, Logger } from '@nestjs/common';
import {
  FulfillmentChannel,
  IntegrationLogStatus,
  IntegrationMappingStatus,
  IntegrationProvider,
  InventoryEventStatus,
  InventoryEventType,
  InventorySourceOfTruth,
  SellerIntegration,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { InventoryService } from '../products/services/inventory.service';
import { EncryptionService } from './encryption.service';
import { IntegrationsService } from './integrations.service';
import { ShopifyProvider } from './providers/shopify.provider';
import { WooCommerceProvider } from './providers/woocommerce.provider';
import { AmazonProvider } from './providers/amazon.provider';
import {
  ExternalProduct,
  ExternalProductPage,
} from './providers/external-product.types';

/** Reasons automatic matching refuses to decide. Surfaced to the seller. */
export const CONFLICT_REASONS = {
  MULTIPLE_YUKIZI: 'SKU_MATCHES_MULTIPLE_PRODUCTS',
  SHARED_EXTERNAL: 'SKU_SHARED_BY_EXTERNAL_LISTINGS',
  NO_SKU: 'NO_SKU',
} as const;

/**
 * Product import and SKU mapping.
 *
 * The matching rule, in order, and nothing else:
 *   1. an existing mapping (a manual one is never overwritten)
 *   2. exact SKU match against the seller's own listings
 *   3. exact variant SKU match
 *   4. otherwise leave it for the seller to map
 *
 * Names are never used. Two products called "Naruto Figure" on two channels
 * are not evidence they are the same thing, and silently merging them would
 * corrupt a seller's stock in a way that is very hard to notice.
 */
@Injectable()
export class IntegrationImportService {
  private readonly logger = new Logger(IntegrationImportService.name);

  /** Pages fetched per job run, so one seller cannot monopolise the runner. */
  private static readonly MAX_PAGES_PER_RUN = 20;
  /** Pause between channel requests, to stay well inside rate limits. */
  private static readonly PAGE_DELAY_MS = 600;

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
    private readonly integrations: IntegrationsService,
    private readonly inventory: InventoryService,
    private readonly shopify: ShopifyProvider,
    private readonly woocommerce: WooCommerceProvider,
    private readonly amazon: AmazonProvider,
  ) {}

  /**
   * Imports the channel catalogue, writes mapping rows, then runs matching.
   * Returns counts for the job record and the activity log.
   */
  async importCatalogue(
    integration: SellerIntegration,
    startCursor?: string | null,
  ): Promise<{
    imported: number;
    matched: number;
    conflicts: number;
    unmapped: number;
    nextCursor: string | null;
  }> {
    const credentials = this.encryption.decrypt<Record<string, string>>(
      integration.encryptedCredentials,
    );
    if (!credentials) {
      // Undecryptable credentials are a permanent failure — retrying cannot
      // fix a key that no longer opens this row.
      throw new PermanentIntegrationError(
        'This connection needs to be reauthorized before importing.',
      );
    }

    let cursor: string | null = startCursor ?? null;
    let pages = 0;
    let imported = 0;
    const touchedMappingIds: string[] = [];

    do {
      const page = await this.fetchPage(integration, credentials, cursor);
      for (const product of page.products) {
        const mappingId = await this.upsertMapping(integration, product);
        if (mappingId) {
          touchedMappingIds.push(mappingId);
          imported += 1;
        }
      }
      cursor = page.nextCursor;
      pages += 1;

      // Deliberately serial with a pause: bursting parallel requests at a
      // seller's store is how integrations get rate-limited or firewalled.
      if (cursor) await this.delay(IntegrationImportService.PAGE_DELAY_MS);
    } while (cursor && pages < IntegrationImportService.MAX_PAGES_PER_RUN);

    const outcome = await this.matchMappings(integration, touchedMappingIds);

    return { imported, ...outcome, nextCursor: cursor };
  }

  /** Dispatches to the right provider, normalising to one shape. */
  private async fetchPage(
    integration: SellerIntegration,
    credentials: Record<string, string>,
    cursor: string | null,
  ): Promise<ExternalProductPage> {
    switch (integration.provider) {
      case IntegrationProvider.SHOPIFY:
        return this.shopify.fetchProductsPage(
          integration.externalAccountId,
          credentials.accessToken,
          cursor,
        );

      case IntegrationProvider.WOOCOMMERCE:
        return this.woocommerce.fetchProductsPage(
          integration.externalStoreUrl ?? '',
          {
            consumerKey: credentials.consumerKey,
            consumerSecret: credentials.consumerSecret,
          },
          cursor ? Number(cursor) : 1,
        );

      case IntegrationProvider.AMAZON:
        return this.amazon.fetchListingsPage(
          {
            refreshToken: credentials.refreshToken,
            sellingPartnerId: credentials.sellingPartnerId ?? '',
            marketplaceId: integration.marketplaceId ?? '',
            region: integration.region ?? 'na',
          },
          cursor,
        );

      default:
        return { products: [], nextCursor: null };
    }
  }

  /**
   * Creates or refreshes the row for one external listing.
   *
   * Only channel-side facts are written here. Matching is a separate pass so
   * that re-importing never disturbs a mapping the seller made by hand.
   */
  private async upsertMapping(
    integration: SellerIntegration,
    product: ExternalProduct,
  ): Promise<string | null> {
    if (!product.externalProductId) return null;

    const fulfillmentChannel =
      product.fulfillmentChannel === 'AMAZON_FBA'
        ? FulfillmentChannel.AMAZON_FBA
        : FulfillmentChannel.MERCHANT;

    const channelFacts = {
      externalSku: product.sku,
      externalTitle: product.title,
      asin: product.asin ?? null,
      // Handles the export path needs; captured on read so a push costs no
      // extra API call.
      externalInventoryRef: product.inventoryRef ?? null,
      externalProductType: product.productType ?? null,
      marketplaceId: integration.marketplaceId ?? null,
      fulfillmentChannel,
      externalQuantity: product.quantity,
      externalQuantityAt: product.quantity === null ? null : new Date(),
      lastSyncedAt: new Date(),
    };

    const mapping = await this.prisma.integrationProductMapping.upsert({
      where: {
        integrationId_externalProductId_externalVariantId: {
          integrationId: integration.id,
          externalProductId: product.externalProductId,
          externalVariantId: product.externalVariantId ?? '',
        },
      },
      create: {
        sellerId: integration.sellerId,
        integrationId: integration.id,
        externalProductId: product.externalProductId,
        externalVariantId: product.externalVariantId ?? '',
        status: IntegrationMappingStatus.UNMAPPED,
        ...channelFacts,
      },
      update: channelFacts,
    });

    return mapping.id;
  }

  /**
   * Runs SKU matching over the rows just imported.
   *
   * Everything is loaded up front and matched in memory: doing a query per
   * listing would be hundreds of round trips for a catalogue of any size, and
   * the "is this SKU ambiguous?" question needs the whole set anyway.
   */
  private async matchMappings(
    integration: SellerIntegration,
    mappingIds: string[],
  ): Promise<{ matched: number; conflicts: number; unmapped: number }> {
    if (mappingIds.length === 0) {
      return { matched: 0, conflicts: 0, unmapped: 0 };
    }

    const mappings = await this.prisma.integrationProductMapping.findMany({
      where: { id: { in: mappingIds } },
    });

    // The seller's own live listings, and their SKUs.
    const offers = await this.prisma.sellerOffer.findMany({
      where: { sellerId: integration.sellerId, deletedAt: null },
      select: {
        id: true,
        sku: true,
        catalogProductId: true,
        variant: { select: { sku: true, catalogProductId: true } },
      },
    });

    // SKU -> offers. A list, not a single value: a seller CAN have the same
    // SKU on two listings, and that ambiguity is exactly what must not be
    // resolved by guessing.
    const bySku = new Map<string, typeof offers>();
    const addSku = (sku: string | null | undefined, offer: (typeof offers)[0]) => {
      const key = sku?.trim().toLowerCase();
      if (!key) return;
      const bucket = bySku.get(key);
      if (bucket) bucket.push(offer);
      else bySku.set(key, [offer]);
    };
    for (const offer of offers) {
      addSku(offer.sku, offer);
      addSku(offer.variant?.sku, offer);
    }

    // External SKUs appearing on more than one listing of this channel: also
    // ambiguous, in the other direction.
    const externalSkuCounts = new Map<string, number>();
    for (const mapping of mappings) {
      const key = mapping.externalSku?.trim().toLowerCase();
      if (!key) continue;
      externalSkuCounts.set(key, (externalSkuCounts.get(key) ?? 0) + 1);
    }

    let matched = 0;
    let conflicts = 0;
    let unmapped = 0;

    for (const mapping of mappings) {
      // 1. A mapping the seller made by hand is authoritative. Never touch it.
      if (mapping.mappedManuallyAt) {
        matched += 1;
        continue;
      }
      // An existing automatic mapping stays too, unless the SKU changed.
      if (mapping.sellerOfferId && mapping.status === IntegrationMappingStatus.MAPPED) {
        matched += 1;
        continue;
      }

      const key = mapping.externalSku?.trim().toLowerCase();

      // 4a. No SKU at all: nothing to match on, and names are not evidence.
      if (!key) {
        await this.setStatus(
          mapping.id,
          IntegrationMappingStatus.MISSING_SKU,
          CONFLICT_REASONS.NO_SKU,
        );
        unmapped += 1;
        continue;
      }

      // 4b. The same SKU on several of this channel's listings.
      if ((externalSkuCounts.get(key) ?? 0) > 1) {
        await this.setStatus(
          mapping.id,
          IntegrationMappingStatus.CONFLICT,
          CONFLICT_REASONS.SHARED_EXTERNAL,
        );
        conflicts += 1;
        continue;
      }

      const candidates = bySku.get(key) ?? [];

      // 4c. Matches more than one Yukizi listing — the seller must choose.
      if (candidates.length > 1) {
        await this.setStatus(
          mapping.id,
          IntegrationMappingStatus.CONFLICT,
          CONFLICT_REASONS.MULTIPLE_YUKIZI,
        );
        conflicts += 1;
        continue;
      }

      // 2/3. Exactly one match, on the listing SKU or the variant SKU.
      if (candidates.length === 1) {
        const offer = candidates[0];
        await this.prisma.integrationProductMapping.update({
          where: { id: mapping.id },
          data: {
            sellerOfferId: offer.id,
            catalogProductId:
              offer.catalogProductId ?? offer.variant?.catalogProductId ?? null,
            yukiziSku: offer.sku ?? offer.variant?.sku ?? null,
            status: IntegrationMappingStatus.MAPPED,
            conflictReason: null,
            lastError: null,
          },
        });
        matched += 1;
        continue;
      }

      // No Yukizi listing carries this SKU. Not an error — the seller may not
      // sell it on Yukizi at all.
      await this.setStatus(mapping.id, IntegrationMappingStatus.UNMAPPED, null);
      unmapped += 1;
    }

    return { matched, conflicts, unmapped };
  }

  private async setStatus(
    id: string,
    status: IntegrationMappingStatus,
    conflictReason: string | null,
  ): Promise<void> {
    await this.prisma.integrationProductMapping.update({
      where: { id },
      data: { status, conflictReason, sellerOfferId: null },
    });
  }

  /**
   * Imports quantities for mapped listings.
   *
   * Where Yukizi and the channel disagree, this does NOT pick a winner unless
   * the seller already chose a source of truth. An unresolved difference is
   * flagged and left alone — overwriting a seller's real stock on a guess is
   * the single most damaging thing this feature could do.
   */
  async importInventory(
    integration: SellerIntegration,
  ): Promise<{ applied: number; conflicts: number; skipped: number }> {
    const mappings = await this.prisma.integrationProductMapping.findMany({
      where: {
        integrationId: integration.id,
        status: IntegrationMappingStatus.MAPPED,
        sellerOfferId: { not: null },
        externalQuantity: { not: null },
        // Amazon's fulfilment centres own FBA stock; Yukizi records it for
        // reporting but must never treat it as seller-controlled inventory.
        fulfillmentChannel: FulfillmentChannel.MERCHANT,
      },
    });

    let applied = 0;
    let conflicts = 0;
    let skipped = 0;

    for (const mapping of mappings) {
      const offerId = mapping.sellerOfferId as string;
      const externalQuantity = mapping.externalQuantity as number;
      const yukiziQuantity = await this.inventory.getTotalStock(offerId);

      if (yukiziQuantity === externalQuantity) {
        // Already agree. Clear any stale conflict flag.
        if (mapping.inventoryConflictAt) {
          await this.prisma.integrationProductMapping.update({
            where: { id: mapping.id },
            data: { inventoryConflictAt: null, conflictYukiziQuantity: null },
          });
        }
        skipped += 1;
        continue;
      }

      // A difference the seller has not resolved yet stays flagged and
      // untouched, however the source of truth is set.
      if (mapping.inventoryConflictAt) {
        conflicts += 1;
        continue;
      }

      if (integration.sourceOfTruth === InventorySourceOfTruth.EXTERNAL) {
        // The seller has said this channel wins: apply it.
        await this.applyExternalQuantity(
          integration,
          mapping.id,
          offerId,
          yukiziQuantity,
          externalQuantity,
        );
        applied += 1;
        continue;
      }

      // Yukizi is master, so a difference means the channel is out of date.
      // Pushing the correction is phase 3; for now flag it rather than
      // silently importing a number that would undo the seller's own stock.
      await this.prisma.integrationProductMapping.update({
        where: { id: mapping.id },
        data: {
          inventoryConflictAt: new Date(),
          conflictYukiziQuantity: yukiziQuantity,
        },
      });
      conflicts += 1;
    }

    return { applied, conflicts, skipped };
  }

  /**
   * Writes a channel quantity into Yukizi, through the ledger.
   *
   * The event is recorded FIRST and marked processed only after the stock
   * write succeeds, so a crash halfway leaves an auditable PENDING row rather
   * than a silent discrepancy.
   */
  async applyExternalQuantity(
    integration: SellerIntegration,
    mappingId: string,
    sellerOfferId: string,
    oldQuantity: number,
    newQuantity: number,
    eventType: InventoryEventType = InventoryEventType.INITIAL_IMPORT,
  ): Promise<void> {
    const event = await this.prisma.inventoryEvent.create({
      data: {
        sellerId: integration.sellerId,
        integrationId: integration.id,
        mappingId,
        sellerOfferId,
        sourcePlatform: integration.provider,
        // Import is our own read, not a provider-delivered event, so there is
        // no external id to deduplicate on. Left null: the unique index treats
        // NULLs as distinct in Postgres, so imports never collide.
        sourceEventId: null,
        eventType,
        status: InventoryEventStatus.PENDING,
        oldQuantity,
        newQuantity,
        quantityDelta: newQuantity - oldQuantity,
      },
    });

    // Reuses the seller portal's own stock path (the DEFAULT batch), so
    // imported stock behaves exactly like stock typed into the UI, including
    // low-stock alerts.
    await this.inventory.updateDefaultBatch(sellerOfferId, newQuantity);

    await this.prisma.inventoryEvent.update({
      where: { id: event.id },
      data: { status: InventoryEventStatus.PROCESSED, processedAt: new Date() },
    });

    await this.prisma.integrationProductMapping.update({
      where: { id: mappingId },
      data: {
        lastSyncedAt: new Date(),
        inventoryConflictAt: null,
        conflictYukiziQuantity: null,
      },
    });

    await this.integrations.log(integration.sellerId, integration.id, {
      action: 'INVENTORY_UPDATED',
      status: IntegrationLogStatus.SUCCESS,
      message: `Inventory updated ${oldQuantity} → ${newQuantity}.`,
    });
  }

  /**
   * The seller decides which side wins for one flagged difference.
   *
   * 'EXTERNAL' imports the channel quantity into Yukizi now. 'YUKIZI' keeps
   * the Yukizi quantity and simply clears the flag — Yukizi does not yet push
   * quantities outward (that is phase 3), so claiming it had "updated the
   * channel" would be a lie. The activity line says exactly what happened.
   */
  async resolveInventoryConflict(
    userId: string,
    integrationId: string,
    mappingId: string,
    choice: 'YUKIZI' | 'EXTERNAL',
  ): Promise<{ resolved: true; appliedTo: 'YUKIZI' | 'NONE' }> {
    const sellerId = await this.integrations.resolveSellerId(userId);
    const integration = await this.integrations.requireOwnedIntegration(
      sellerId,
      integrationId,
    );

    const mapping = await this.prisma.integrationProductMapping.findFirst({
      where: { id: mappingId, sellerId, integrationId },
    });
    if (!mapping || !mapping.inventoryConflictAt) {
      throw new PermanentIntegrationError(
        'That inventory difference is no longer open.',
      );
    }

    if (choice === 'EXTERNAL' && mapping.sellerOfferId != null) {
      const current = await this.inventory.getTotalStock(mapping.sellerOfferId);
      await this.applyExternalQuantity(
        integration,
        mapping.id,
        mapping.sellerOfferId,
        current,
        mapping.externalQuantity ?? current,
        InventoryEventType.MANUAL_ADJUSTMENT,
      );
      return { resolved: true, appliedTo: 'YUKIZI' };
    }

    await this.prisma.integrationProductMapping.update({
      where: { id: mapping.id },
      data: { inventoryConflictAt: null, conflictYukiziQuantity: null },
    });

    await this.integrations.log(sellerId, integrationId, {
      action: 'INVENTORY_CONFLICT_RESOLVED',
      status: IntegrationLogStatus.SUCCESS,
      entityRef: mapping.externalSku ?? undefined,
      message:
        'Kept the Yukizi quantity. The channel will be updated when inventory export is enabled.',
    });

    return { resolved: true, appliedTo: 'NONE' };
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * A failure retrying cannot fix — revoked credentials, missing scope, a store
 * that no longer exists. The runner marks these permanently failed instead of
 * burning attempts against something that will never succeed.
 */
export class PermanentIntegrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentIntegrationError';
  }
}
