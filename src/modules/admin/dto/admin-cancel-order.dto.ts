import {
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Admin cancellation. Separate from CancelOrderDto because the two have
 * different obligations, not just different defaults.
 *
 * A buyer cancelling their own unpaid order owes nobody an explanation, so
 * CancelOrderDto.reason is optional. An admin is cancelling on someone
 * else's behalf and the reason is what that buyer is told, so here it is
 * required at the API rather than only in the UI.
 */
export class AdminCancelOrderDto {
  @ApiProperty({ example: 'Item out of stock at the seller' })
  @IsString()
  @MinLength(3, { message: 'Give a reason of at least 3 characters' })
  @MaxLength(300)
  reason!: string;

  /**
   * Required only when the order has a confirmed payment and no refund has
   * been recorded against it — see AdminService.adminCancelOrder.
   *
   * Cancelling restores stock and tells the buyer their order is gone. Doing
   * that to an order whose money is still held, with nothing recorded about
   * returning it, is how inventory and the ledger drift apart. The API cannot
   * verify a refund actually happened (it may be issued straight from the
   * Razorpay dashboard), so it asks the admin to state that they have handled
   * it, and refuses rather than assuming.
   */
  @ApiPropertyOptional({
    description:
      'Must be true to cancel a paid order that has no refund recorded yet.',
  })
  @IsOptional()
  @IsBoolean()
  refundHandled?: boolean;
}
