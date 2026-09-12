import {
  IsString,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsInt,
  IsDateString,
  IsEnum,
  IsBoolean,
  IsArray,
  IsUrl,
  IsObject,
  Min,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DiscountType } from '@prisma/client';

export class CreateProductDto {
  @ApiProperty({ example: 'Paracetamol 500mg', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 'uuid-of-category' })
  @IsString()
  @IsNotEmpty()
  categoryId: string;

  @ApiProperty({ example: 'uuid-of-subcategory' })
  @IsString()
  @IsNotEmpty()
  subCategoryId: string;

  @ApiProperty({ example: 'Cipla Ltd', maxLength: 255 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  manufacturer: string;

  @ApiProperty({ example: 'Paracetamol IP 500mg' })
  @IsString()
  @IsOptional()
  specifications?: string;

  @IsString()
  @IsOptional()
  sku?: string;

  @IsString()
  @IsOptional()
  serialNo?: string;

  @ApiPropertyOptional({ example: 'Analgesic and antipyretic tablet' })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ example: 25.5, description: 'MRP in INR' })
  @IsNumber()
  @Min(0)
  mrp: number;

  @ApiProperty({ example: 12, description: 'GST percentage' })
  @IsNumber()
  @Min(0)
  gstPercent: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isTaxIncluded?: boolean;

  @IsOptional()
  @IsNumber()
  shippingCharges?: number;

  @IsOptional()
  @IsNumber()
  finalShippingPrice?: number;

  @ApiPropertyOptional({ example: 10, minimum: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  minimumOrderQuantity?: number;

  @ApiPropertyOptional({ example: 1000, minimum: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  maximumOrderQuantity?: number;

  @ApiProperty({ example: 500, description: 'Initial stock count' })
  @IsInt()
  @Min(0)
  stock: number;

  /**
   * Accepted and ignored.
   *
   * Collectables do not expire. This was mandatory, which is why the seller
   * form invented 2099-12-31 for every product ever listed. It stays in the
   * DTO, optional, only so a client that has not been redeployed yet is not
   * rejected by `forbidNonWhitelisted` — nothing reads it, and it will be
   * deleted once every caller has stopped sending it.
   *
   * @deprecated
   */
  @ApiPropertyOptional({ deprecated: true, description: 'Ignored. Collectables do not expire.' })
  @IsOptional()
  @IsDateString()
  expiryDate?: string;

  // ── Image Support ──────────────────────────────
  @ApiPropertyOptional({
    example: ['https://example.com/img1.jpg', 'https://example.com/img2.jpg'],
    description: 'Array of product image URLs',
  })
  @IsArray()
  @IsString({ each: true })
  @ValidateIf((o) => !o.isMigration)
  @IsUrl({}, { each: true, message: 'Each image must be a valid URL' })
  @IsOptional()
  images?: string[];

  // 🛒 Discount Engine ----------------------------
  @ApiPropertyOptional({
    enum: DiscountType,
    example: 'SAME_PRODUCT_BONUS',
    description: 'Type of discount applied to this product',
  })
  @ValidateIf((object, value) => value !== null)
  @IsEnum(DiscountType)
  @IsOptional()
  discountType?: DiscountType | null;

  @ApiPropertyOptional({
    example: { discountPercent: 10 },
    description: 'JSON metadata for the discount',
  })
  @ValidateIf((object, value) => value !== null)
  @IsObject()
  @IsOptional()
  discountMeta?: Prisma.InputJsonValue;

  @ApiPropertyOptional({
    example: 'Tomorrow',
    description: 'Dynamic delivery timeframe text',
  })
  @IsString()
  @IsOptional()
  deliveryText?: string;

  // ── Migration / Idempotency ────────────────────
  @ApiPropertyOptional({
    example: '507f1f77bcf86cd799439011',
    description:
      'External ID from legacy system (MongoDB ObjectId) for idempotent migration',
  })
  @IsString()
  @IsOptional()
  externalId?: string;

  @ApiPropertyOptional({
    example: 'paracetamol-500mg-cipla',
    description: 'URL-friendly slug (auto-generated if not provided)',
  })
  @IsString()
  @IsOptional()
  slug?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'Set to true during data migration to relax non-critical validations',
  })
  @IsBoolean()
  @IsOptional()
  isMigration?: boolean;

  @ApiPropertyOptional({
    example: 'uuid-of-master-product',
    description:
      'ID of the master product from catalog (if used, bypasses approval)',
  })
  @IsString()
  @IsOptional()
  variantId?: string;

  @ApiPropertyOptional({
    example: 'uuid-of-master-product-selected',
    description: 'Master Product ID when adding from catalog',
  })
  @IsString()
  @IsOptional()
  masterProductId?: string;

  @ApiPropertyOptional({
    description: 'Variant options configuration',
  })
  @IsArray()
  @IsOptional()
  options?: any[];

  @ApiPropertyOptional({
    description: 'List of product variants',
  })
  @IsArray()
  @IsOptional()
  variants?: any[];

  @ApiPropertyOptional({
    description: 'Custom extra fields from seller product form',
  })
  @IsObject()
  @IsOptional()
  extraFields?: Record<string, any>;
}
