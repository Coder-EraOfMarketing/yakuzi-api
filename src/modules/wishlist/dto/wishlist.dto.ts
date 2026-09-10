import { IsArray, IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddWishlistItemDto {
  @ApiProperty({ description: 'The product id the storefront saved' })
  @IsString()
  @IsNotEmpty({ message: 'productId is required' })
  @MaxLength(64)
  productId: string;
}

/** What a browser had saved before the buyer signed in. */
export class MergeWishlistDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  productIds: string[];
}
