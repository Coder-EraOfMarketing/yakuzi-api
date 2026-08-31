import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Admin review filters. A product can be sold by several sellers, so
 * `sellerId` filters by the seller whose LISTING was actually purchased
 * (Review.sellerOfferId -> SellerOffer.sellerId), not by "sellers who happen
 * to sell this product" — otherwise one seller's rating would be polluted by
 * another's sales of the same catalog product.
 */
export class QueryAdminReviewsDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Seller profile id (whose listing was bought)' })
  @IsOptional() @IsUUID()
  sellerId?: string;

  @ApiPropertyOptional({ description: 'Catalog product id' })
  @IsOptional() @IsUUID()
  productId?: string;

  @ApiPropertyOptional({ description: 'Buyer user id' })
  @IsOptional() @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Category id of the catalog product' })
  @IsOptional() @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ description: 'ISO date — reviews on/after' })
  @IsOptional() @IsString()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'ISO date — reviews on/before' })
  @IsOptional() @IsString()
  dateTo?: string;

  @ApiPropertyOptional({ description: 'Exact star rating' })
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5)
  rating?: number;

  @ApiPropertyOptional({ description: 'Free text over comment / product name' })
  @IsOptional() @IsString()
  search?: string;
}

/** Seller-facing filters: the same minus anything buyer-identifying. */
export class QuerySellerReviewsDto {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  limit?: number;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  productId?: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  dateFrom?: string;

  @ApiPropertyOptional() @IsOptional() @IsString()
  dateTo?: string;

  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(5)
  rating?: number;
}
