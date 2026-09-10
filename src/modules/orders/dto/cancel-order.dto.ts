import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Optional at the API, because a buyer cancelling their own unpaid order owes
 * nobody an explanation. The admin screen requires it — an order cancelled on
 * someone's behalf without a reason is a support ticket waiting to happen, and
 * the reason is what the buyer is told.
 */
export class CancelOrderDto {
  @ApiPropertyOptional({ example: 'Item out of stock at the seller' })
  @IsOptional()
  @IsString()
  @MinLength(3, { message: 'Give a reason of at least 3 characters' })
  @MaxLength(300)
  reason?: string;
}
