import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IntegrationProvider,
  IntegrationSyncDirection,
  InventorySourceOfTruth,
} from '@prisma/client';

/** Starts a Shopify authorisation. */
export class StartShopifyConnectionDto {
  @ApiProperty({
    example: 'storename.myshopify.com',
    description:
      'Shopify store domain. A pasted admin URL is normalised server-side.',
  })
  @IsString()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  shopDomain: string;
}

/** Starts a WooCommerce authorisation. */
export class StartWooCommerceConnectionDto {
  @ApiProperty({
    example: 'https://mystore.com',
    description: 'WooCommerce store URL. Normalised and SSRF-checked.',
  })
  @IsString()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  storeUrl: string;
}

/** Starts an Amazon SP-API authorisation. */
export class StartAmazonConnectionDto {
  @ApiProperty({
    example: 'A21TJRUUN4KGV',
    description: 'Amazon marketplace id the seller sells on.',
  })
  @IsString()
  @MaxLength(32)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  marketplaceId: string;
}

/** Pre-flight probe shown in the WooCommerce connect modal. */
export class CheckWooCommerceStoreDto {
  @ApiProperty({ example: 'https://mystore.com' })
  @IsString()
  @MaxLength(255)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  storeUrl: string;
}

/**
 * Sync settings a seller may change. Every field optional — the UI sends only
 * what the seller toggled.
 */
export class UpdateIntegrationSettingsDto {
  @ApiPropertyOptional({ description: 'Master switch for this connection.' })
  @IsOptional()
  @IsBoolean()
  syncEnabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  syncProducts?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  syncInventory?: boolean;

  @ApiPropertyOptional({
    description:
      'Import channel orders for visibility. Never creates Yukizi orders and never moves stock.',
  })
  @IsOptional()
  @IsBoolean()
  syncOrders?: boolean;

  @ApiPropertyOptional({
    description:
      'Send Yukizi prices to the channel. Off by default — it changes what a live storefront charges.',
  })
  @IsOptional()
  @IsBoolean()
  syncPrices?: boolean;

  @ApiPropertyOptional({
    enum: IntegrationSyncDirection,
    description:
      'TWO_WAY is only accepted for providers with loop protection enabled.',
  })
  @IsOptional()
  @IsEnum(IntegrationSyncDirection)
  inventoryDirection?: IntegrationSyncDirection;

  @ApiPropertyOptional({ enum: InventorySourceOfTruth })
  @IsOptional()
  @IsEnum(InventorySourceOfTruth)
  sourceOfTruth?: InventorySourceOfTruth;
}

/** Completes the post-connection wizard. */
export class CompleteSetupDto {
  @ApiProperty()
  @IsBoolean()
  syncProducts: boolean;

  @ApiProperty()
  @IsBoolean()
  syncInventory: boolean;

  @ApiProperty({ enum: IntegrationSyncDirection })
  @IsEnum(IntegrationSyncDirection)
  inventoryDirection: IntegrationSyncDirection;

  @ApiProperty({ enum: InventorySourceOfTruth })
  @IsEnum(InventorySourceOfTruth)
  sourceOfTruth: InventorySourceOfTruth;
}

/** Manual product mapping chosen by the seller. */
export class MapProductDto {
  @ApiProperty({ description: 'Yukizi seller offer (listing) id.' })
  @IsUUID()
  sellerOfferId: string;
}

/**
 * Which side wins for one flagged inventory difference. Required — Yukizi
 * never picks for the seller.
 */
export class ResolveInventoryConflictDto {
  @ApiProperty({
    enum: ['YUKIZI', 'EXTERNAL'],
    description:
      "EXTERNAL imports the channel quantity into Yukizi. YUKIZI keeps Yukizi's quantity and clears the flag.",
  })
  @IsIn(['YUKIZI', 'EXTERNAL'])
  choice: 'YUKIZI' | 'EXTERNAL';
}

/** Search for a Yukizi listing to map an external one onto. */
export class QueryMappingCandidatesDto {
  @ApiPropertyOptional({ description: 'Match on product name or SKU.' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export class QueryIntegrationActivityDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

export class QueryMappingsDto extends QueryIntegrationActivityDto {
  @ApiPropertyOptional({
    description: 'Filter by mapping status (mapped/unmapped/conflict/missing_sku).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}

export { IntegrationProvider };
