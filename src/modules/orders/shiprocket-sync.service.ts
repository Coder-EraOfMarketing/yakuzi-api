import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { OrderStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ShiprocketService } from './shiprocket.service';
import { OrdersService } from './orders.service';
import { mapShiprocketStatus, isForwardStatusMove } from './shiprocket-status-map';
import { payoutOfferSelect } from '../settlements/payout-calculator';

interface PollableOrder {
  id: string;
  shiprocketOrderId: string | null;
  orderStatus: OrderStatus;
}

/**
 * Keeps Order.orderStatus in sync with Shiprocket's own tracking status for
 * every order that's been pushed to Shiprocket (shiprocketOrderId set) and
 * isn't yet in a terminal state. Runs every 30 minutes — order volume on
 * this project is low enough that polling stays well under Shiprocket's
 * rate limits without needing a webhook. See
 * docs/superpowers/specs/2026-08-17-shiprocket-status-sync-design.md.
 */
@Injectable()
export class ShiprocketSyncService {
  private readonly logger = new Logger(ShiprocketSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shiprocketService: ShiprocketService,
    private readonly ordersService: OrdersService,
  ) {}

  @Cron('*/30 * * * *')
  async handleCron(): Promise<void> {
    await this.syncInFlightOrders();
  }

  async syncInFlightOrders(): Promise<void> {
    const orders = await this.prisma.order.findMany({
      where: {
        shiprocketOrderId: { not: null },
        orderStatus: {
          notIn: [
            OrderStatus.DELIVERED,
            OrderStatus.RETURNED,
            OrderStatus.CANCELLED,
          ],
        },
      },
      select: { id: true, shiprocketOrderId: true, orderStatus: true },
    });

    // Intentionally sequential (not Promise.all) — avoids tripping
    // Shiprocket's rate limits by hammering their API with concurrent
    // requests.
    for (const order of orders) {
      await this.syncOneOrder(order);
    }
  }

  async syncOneOrder(order: PollableOrder): Promise<void> {
    if (!order.shiprocketOrderId) return;

    let tracking: Awaited<ReturnType<ShiprocketService['trackOrder']>>;
    try {
      tracking = await this.shiprocketService.trackOrder(
        order.shiprocketOrderId,
      );
    } catch (error: any) {
      this.logger.warn(
        `Shiprocket tracking failed for order ${order.id}: ${error?.message}`,
      );
      return;
    }

    const mapped = mapShiprocketStatus(tracking.current_status);
    if (!mapped) {
      if (tracking.current_status) {
        this.logger.warn(
          `Unrecognized Shiprocket status "${tracking.current_status}" for order ${order.id}`,
        );
      }
      return;
    }

    if (!isForwardStatusMove(order.orderStatus, mapped)) {
      return;
    }

    try {
      // Order matters: syncTrackingFields self-protects (it catches and
      // logs its own DB errors, never throwing), so writing it first means
      // a silent failure there leaves orderStatus un-flipped and the order
      // gets retried next poll instead of being stranded.
      await this.ordersService.syncTrackingFields(order.id, {
        awb_code: tracking.awb_code,
        courier: tracking.courier,
        track_url: tracking.track_url as string | null,
      });

      // Conditional write guarded on the orderStatus snapshot read at the
      // start of this batch. If an admin manually changed this order's
      // status in the window between the batch query and this write (e.g.
      // cancelled it), `count` comes back 0 and we back off rather than
      // clobbering their change — the order gets re-evaluated fresh next
      // poll cycle instead.
      const result = await this.prisma.order.updateMany({
        where: { id: order.id, orderStatus: order.orderStatus },
        data: { orderStatus: mapped },
      });

      if (result.count === 0) {
        this.logger.warn(
          `Order ${order.id} status changed concurrently — skipping this cycle's Shiprocket sync update`,
        );
        return;
      }

      // Every other path that sets an order to DELIVERED (admin/seller
      // manual updates) also creates seller settlements — this poller must
      // do the same or sellers silently never get paid for auto-synced
      // deliveries.
      if (mapped === OrderStatus.DELIVERED) {
        try {
          const delivered = await this.prisma.order.findUnique({
            where: { id: order.id },
            include: {
              // payoutOfferSelect, not a hand-rolled list: this order goes
              // straight to the settlement writer, and the old list reached
              // the catalogue product through the variant only, so an offer
              // linked directly to a product settled at 0%.
              items: { include: { sellerOffer: { select: payoutOfferSelect } } },
            },
          });
          if (delivered) {
            await this.ordersService.createSettlementsForDeliveredOrder(
              delivered,
            );
          }
        } catch (error: any) {
          // Unlike every other failure in this method, this one is NOT
          // retryable: the updateMany above already flipped orderStatus to
          // DELIVERED, so this order permanently drops out of
          // syncInFlightOrders's batch query (the notIn filter excludes
          // DELIVERED orders) and will never be re-evaluated. Logged at
          // error level — not warn — so it's distinguishable from routine,
          // self-healing warnings and someone watching logs/alerts notices
          // it needs a manual reconciliation.
          this.logger.error(
            `Order ${order.id} was marked DELIVERED but settlement creation failed — sellers may not be paid for this order until manually reconciled: ${error?.message}`,
          );
        }
      }
    } catch (error: any) {
      this.logger.warn(
        `Failed to apply Shiprocket status update for order ${order.id}: ${error?.message}`,
      );
    }
  }
}
