import {
  IsString,
  IsNumber,
  IsOptional,
  IsInt,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsArray,
  IsUrl,
  IsObject,
  Min,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { Prisma } from '@prisma/client';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { DiscountType } from '@prisma/client';

export class UpdateProductDto {
  @ApiPropertyOptional({ example: 'Paracetamol 500mg', maxLength: 255 })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: 'uuid-of-category' })
  @IsString()
  @IsOptional()
  categoryId?: string;

  @ApiPropertyOptional({ example: 'uuid-of-subcategory' })
  @IsString()
  @IsOptional()
  subCategoryId?: string;

  @ApiPropertyOptional({ example: 'Cipla Ltd', maxLength: 255 })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  manufacturer?: string;

  @ApiPropertyOptional({ example: 'Paracetamol IP 500mg' })
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

  @ApiPropertyOptional({ example: 25.5, description: 'MRP in INR' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  mrp?: number;

  @ApiPropertyOptional({ example: 12, description: 'GST percentage' })
  @IsNumber()
  @Min(0)
  @IsOptional()
  gstPercent?: number;

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

  @ApiPropertyOptional({ example: true })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiPropertyOptional({ example: 500, description: 'Updated stock count' })
  @IsInt()
  @Min(0)
  @IsOptional()
  stock?: number;

  @ApiPropertyOptional({
    example: '2026-12-31',
    description: 'ISO date string',
  })
  @IsDateString()
  @IsOptional()
  /** Accepted and ignored — see CreateProductDto.expiryDate. @deprecated */
  expiryDate?: string;

  // ── Image Support ──────────────────────────────
  @ApiPropertyOptional({
    example: ['https://example.com/img1.jpg'],
    description: 'Array of product image URLs (replaces existing images)',
  })
  @IsArray()
  @IsString({ each: true })
  @IsUrl({}, { each: true, message: 'Each image must be a valid URL' })
  @IsOptional()
  images?: string[];

  // ── Discount Engine ────────────────────────────
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
    example: { buy: 10, get: 2 },
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
