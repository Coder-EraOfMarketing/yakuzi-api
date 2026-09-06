/**
 * The one shape every channel's catalogue is normalised into before it reaches
 * the import logic.
 *
 * Keeping this deliberately small matters: the SKU matcher must behave
 * identically no matter which platform a listing came from, so it is never
 * allowed to see a provider-specific payload.
 */
export interface ExternalProduct {
  /** The channel's id for the parent product. */
  externalProductId: string;
  /** The channel's id for the specific variant, when it has one. */
  externalVariantId: string | null;
  /** Trimmed, or null when the listing genuinely has no SKU. */
  sku: string | null;
  /** Display title, used only for showing the seller what a row refers to. */
  title: string | null;
  /** Stock the channel reports, or null when it does not track it. */
  quantity: number | null;
  /**
   * MERCHANT for anything the seller controls; AMAZON_FBA for stock held in
   * Amazon's fulfilment centres, which Yukizi displays but never overwrites.
   */
  fulfillmentChannel: 'MERCHANT' | 'AMAZON_FBA';
  /** Amazon only. */
  asin?: string | null;
  /**
   * Provider-specific handle needed to WRITE a quantity back:
   * Shopify's inventory_item_id. Null when the channel does not need one.
   */
  inventoryRef?: string | null;
  /** Amazon only: productType, required by the Listings Items PATCH. */
  productType?: string | null;
}

/** One page of a channel catalogue plus the cursor to continue from. */
export interface ExternalProductPage {
  products: ExternalProduct[];
  /** Opaque; passed back verbatim. Null on the last page. */
  nextCursor: string | null;
}
