import { Injectable, Logger } from '@nestjs/common';
import { AlertType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Internal inventory management service.
 * Handles batch-level stock and low-stock alerts.
 * NOT exposed as public API — called internally by ProductsService.
 *
 * Batches are how stock is physically stored, inherited from the pharmaceutical
 * marketplace this codebase was forked from. What has been removed is the
 * EXPIRY half of that model: a collectable does not expire, so nothing here
 * asks for a date, invents one, sorts by one, or raises an alert about one.
 * `ProductBatch.expiryDate` is nullable and simply stays null on everything
 * created from now on.
 */
@Injectable()
export class InventoryService {
  private readonly logger = new Logger(InventoryService.name);

  /** Low-stock threshold */
  private readonly LOW_STOCK_THRESHOLD = 10;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Create the batch a product's stock lives in.
   */
  async createDefaultBatch(sellerOfferId: string, stock: number) {
    const batch = await this.prisma.productBatch.create({
      data: {
        sellerOfferId,
        batchNumber: 'DEFAULT',
        stock,
      },
    });

    this.logger.debug(
      `Default batch created for product ${sellerOfferId}: stock=${stock}`,
    );

    // Fire-and-forget: check alerts for the new batch
    this.checkBatchAlerts(sellerOfferId, batch.id, stock);

    return batch;
  }

  /**
   * Set a product's stock.
   */
  async updateDefaultBatch(sellerOfferId: string, stock?: number) {
    const existing = await this.prisma.productBatch.findFirst({
      where: { sellerOfferId, batchNumber: 'DEFAULT' },
    });

    if (!existing) {
      this.logger.warn(
        `No default batch found for product ${sellerOfferId}, creating one`,
      );
      return this.createDefaultBatch(sellerOfferId, stock ?? 0);
    }

    if (stock === undefined) return existing;

    const batch = await this.prisma.productBatch.update({
      where: { id: existing.id },
      data: { stock },
    });

    this.logger.debug(
      `Default batch updated for product ${sellerOfferId}: stock=${batch.stock}`,
    );

    // Fire-and-forget: re-check alerts
    this.checkBatchAlerts(sellerOfferId, batch.id, batch.stock);

    return batch;
  }

  /**
   * Get aggregated stock across all batches for a product.
   */
  async getTotalStock(sellerOfferId: string): Promise<number> {
    const result = await this.prisma.productBatch.aggregate({
      where: { sellerOfferId },
      _sum: { stock: true },
    });
    return result._sum.stock ?? 0;
  }

  /**
   * Check batch and generate inventory alerts if thresholds are breached.
   * Runs asynchronously — failures are logged but don't propagate.
   */
  private async checkBatchAlerts(
    sellerOfferId: string,
    batchId: string,
    stock: number,
  ) {
    try {
      const alerts: { alertType: AlertType; message: string }[] = [];

      // Out-of-stock / low-stock check
      if (stock === 0) {
        alerts.push({
          alertType: AlertType.OUT_OF_STOCK,
          message: 'Batch is out of stock',
        });
      } else if (stock <= this.LOW_STOCK_THRESHOLD) {
        alerts.push({
          alertType: AlertType.OUT_OF_STOCK,
          message: `Low stock: only ${stock} units remaining`,
        });
      }

      if (alerts.length > 0) {
        await this.prisma.inventoryAlert.createMany({
          data: alerts.map((a) => ({
            sellerOfferId,
            batchId,
            alertType: a.alertType,
            message: a.message,
          })),
        });
        this.logger.log(
          `Created ${alerts.length} inventory alert(s) for product ${sellerOfferId}`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to check batch alerts for product ${sellerOfferId}: ${error}`,
      );
    }
  }
}
