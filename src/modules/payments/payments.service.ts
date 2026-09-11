import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UploadProofDto } from './dto/upload-proof.dto';
import {
  PaymentStatus,
  PaymentVerificationStatus,
  OrderStatus,
} from '@prisma/client';
import { calculateSellerPayout } from '../settlements/payout-calculator';
import { InvoiceEmailService } from '../orders/invoice-email.service';
import { SellerOrderNotifierService } from '../orders/seller-order-notifier.service';
import { WebAnalyticsService } from '../web-analytics/web-analytics.service';
import { checkoutGroupWhere } from './checkout-group';

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);
  private readonly commissionRate: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly invoiceEmailService: InvoiceEmailService,
    private readonly webAnalytics: WebAnalyticsService,
    private readonly sellerOrderNotifier: SellerOrderNotifierService,
  ) {
    this.commissionRate = parseFloat(
      this.config.get<string>('PLATFORM_COMMISSION_RATE', '0.05'),
    );
  }

  // ──────────────────────────────────────────────
  // BUYER: Record a payment attempt
  // ──────────────────────────────────────────────

  async createPayment(userId: string, dto: CreatePaymentDto) {
    const { orderId, amount, method, referenceNumber } = dto;

    // 1. Verify order exists and belongs to buyer
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.buyerId !== userId) {
      throw new NotFoundException('Order not found');
    }

    // 2. Every order this buyer's checkout produced — one per seller — since a
    // single payment settles the whole basket. Orders placed before the group
    // id existed still fall back to the old "within five seconds" rule.
    const relatedOrders = await this.prisma.order.findMany({
      where: { ...checkoutGroupWhere(order), buyerId: userId },
    });

    // Check if order is already fully paid
    if (order.paymentStatus === PaymentStatus.SUCCESS) {
      throw new BadRequestException('Order is already fully paid');
    }

    // 3. Compute combined remaining balance dynamically across all related orders
    let totalCombinedRemaining = 0;
    for (const ro of relatedOrders) {
      const roConfirmedTotal = await this.getConfirmedTotal(ro.id);
      const roRemaining = Math.max(0, ro.totalAmount.toNumber() - roConfirmedTotal);
      totalCombinedRemaining += roRemaining;
    }

    if (totalCombinedRemaining <= 0) {
      throw new BadRequestException('Order is already fully paid');
    }

    // 4. Validate amount does not exceed remaining
    if (amount > totalCombinedRemaining + 0.01) {
      throw new BadRequestException(
        `Amount exceeds remaining balance. Remaining: ₹${totalCombinedRemaining.toFixed(2)}`,
      );
    }

    // 5. Create payment record
    const payment = await this.prisma.payment.create({
      data: {
        orderId,
        amount,
        method,
        referenceNumber: referenceNumber || null,
        verificationStatus: PaymentVerificationStatus.PENDING,
      },
    });

    this.logger.log(
      `Payment recorded: ${payment.id} — ₹${amount} via ${method} for order ${orderId} (part of group of ${relatedOrders.length} orders)`,
    );

    return payment;
  }

  // ──────────────────────────────────────────────
  // BUYER: Upload payment proof
  // ──────────────────────────────────────────────

  async uploadProof(userId: string, paymentId: string, dto: UploadProofDto) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: { order: { select: { buyerId: true } } },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.order.buyerId !== userId) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.verificationStatus !== PaymentVerificationStatus.PENDING) {
      throw new BadRequestException(
        `Cannot upload proof for a ${payment.verificationStatus.toLowerCase()} payment`,
      );
    }

    const updated = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { proofUrl: dto.proofUrl },
    });

    this.logger.log(`Proof uploaded for payment ${paymentId}`);
    return updated;
  }

  async uploadProofByOrder(
    userId: string,
    orderId: string,
    dto: UploadProofDto,
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { payments: true },
    });

    if (!order || order.buyerId !== userId) {
      throw new NotFoundException('Order not found');
    }

    // Update existing pending payment or create new one
    let payment = order.payments.find(
      (p) => p.verificationStatus === PaymentVerificationStatus.PENDING,
    );

    if (payment) {
      payment = await this.prisma.payment.update({
        where: { id: payment.id },
        data: { proofUrl: dto.proofUrl },
      });
    } else {
      payment = await this.prisma.payment.create({
        data: {
          orderId,
          amount: order.totalAmount,
          method: 'BANK_TRANSFER',
          proofUrl: dto.proofUrl,
          verificationStatus: PaymentVerificationStatus.PENDING,
        },
      });
    }

    this.logger.log(
      `Proof uploaded for order ${orderId} — payment ${payment.id}`,
    );
    return payment;
  }

  // ──────────────────────────────────────────────
  // BUYER: Get all payments for an order
  // ──────────────────────────────────────────────

  async getOrderPayments(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.buyerId !== userId) {
      throw new NotFoundException('Order not found');
    }

    const payments = await this.prisma.payment.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        orderId: true,
        amount: true,
        method: true,
        referenceNumber: true,
        proofUrl: true,
        verificationStatus: true,
        createdAt: true,
      },
    });

    const confirmedTotal = await this.getConfirmedTotal(orderId);
    const remaining = Math.max(0, order.totalAmount.toNumber() - confirmedTotal);

    return {
      orderId,
      totalAmount: order.totalAmount.toNumber(),
      totalPaid: confirmedTotal,
      remaining,
      paymentStatus: this.computePaymentStatus(
        confirmedTotal,
        order.totalAmount.toNumber(),
      ),
      payments,
    };
  }

  // ──────────────────────────────────────────────
  // ADMIN: Confirm a payment
  // ──────────────────────────────────────────────

  async confirmPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      include: {
        order: true,
      },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.verificationStatus === PaymentVerificationStatus.CONFIRMED) {
      throw new BadRequestException('Payment is already confirmed');
    }

    if (payment.verificationStatus === PaymentVerificationStatus.REJECTED) {
      throw new BadRequestException('Cannot confirm a rejected payment');
    }

    // Every order the same checkout produced — this payment covers the basket,
    // not just the order it is attached to. Pre-group-id orders keep the old
    // "same buyer, within five seconds" behaviour.
    const relatedOrders = await this.prisma.order.findMany({
      where: {
        ...checkoutGroupWhere(payment.order),
        buyerId: payment.order.buyerId,
      },
      include: {
        items: {
          include: {
            sellerOffer: {
              select: { 
                id: true, 
                name: true, 
                category: true,
                finalShippingPrice: true,
                shippingCharges: true,
                variant: {
                  include: {
                    catalogProduct: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    // Transactional: confirm payment + recalculate order status + maybe settle for each order in the group
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Mark payment as CONFIRMED
      const confirmed = await tx.payment.update({
        where: { id: paymentId },
        data: { verificationStatus: PaymentVerificationStatus.CONFIRMED },
      });

      let confirmedTotalPaid = 0;
      let targetOrderNewStatus: PaymentStatus = PaymentStatus.SUCCESS;

      for (const ro of relatedOrders) {
        // Fetch existing confirmed payments for this order
        const confirmedPayments = await tx.payment.findMany({
          where: {
            orderId: ro.id,
            verificationStatus: PaymentVerificationStatus.CONFIRMED,
          },
        });

        let roPaid = confirmedPayments.reduce((sum, p) => sum + p.amount.toNumber(), 0);
        // If this is the primary order linked to the payment, add this payment's amount
        if (ro.id === payment.orderId) {
          roPaid += payment.amount.toNumber();
        }

        // Check if the total payment amount covers the remaining group balance.
        // If yes, we can treat the entire group as paid.
        const totalRemainingForOthers = relatedOrders.reduce((sum, o) => {
          if (o.id === payment.orderId) return sum;
          return sum + o.totalAmount.toNumber();
        }, 0);

        const isGroupFullyPaid = payment.amount.toNumber() >= (payment.order.totalAmount.toNumber() - (ro.id === payment.orderId ? 0 : roPaid) + totalRemainingForOthers);
        const finalPaidAmount = isGroupFullyPaid ? ro.totalAmount.toNumber() : roPaid;

        const newStatus = this.computePaymentStatus(
          finalPaidAmount,
          ro.totalAmount.toNumber(),
        );

        if (ro.id === payment.orderId) {
          targetOrderNewStatus = newStatus;
          confirmedTotalPaid = finalPaidAmount;
        }

        // Payment success no longer advances orderStatus — the "Paid"
        // stepper stage was removed from the pipeline (2026-08-23 spec).
        // paymentStatus alone is the source of payment truth; the shipping
        // pipeline (PLACED -> ACCEPTED -> READY_TO_SHIP -> ...) is driven
        // by seller actions and Shiprocket sync.
        await tx.order.update({
          where: { id: ro.id },
          data: { paymentStatus: newStatus },
        });

        // 3. If fully paid AND delivered → create seller settlements
        if (
          newStatus === PaymentStatus.SUCCESS &&
          ro.orderStatus === OrderStatus.DELIVERED
        ) {
          await this.createSettlements(tx, ro.items);
        }
      }

      return { confirmed, confirmedTotalPaid, targetOrderNewStatus };
    });

    // Email the buyer their tax invoice(s). Detached on purpose: a mail failure
    // must never fail, slow or roll back a payment confirmation. Checkout splits
    // one cart into an order per seller, so the whole group that this payment
    // just confirmed goes out as a single email.
    this.invoiceEmailService.dispatchForOrders(relatedOrders.map((o) => o.id));

    // A Razorpay-intent checkout (see CreateOrderDto.deferSellerNotification)
    // left sellersNotifiedAt null and skipped telling sellers about the
    // order at all - this is where that deferred notification actually
    // fires, now that the order is genuinely paid for. Detached like the
    // invoice email: never blocks a confirmation.
    //
    // This runs on every confirmPayment() call - browser verify, webhook,
    // AND admin manual confirm - so it must not double-notify an order that
    // was already notified immediately at checkout (every non-Razorpay
    // order). The atomic updateMany claim below is what makes that safe:
    // whichever caller's update actually flips a row from null is the only
    // one that goes on to notify, even if the browser's /verify and the
    // webhook both land for the same payment.
    void this.notifyDeferredSellers(relatedOrders.map((o) => o.id)).catch(
      (err) => {
        this.logger.warn(
          `Deferred seller notification failed for payment ${paymentId}: ${
            err instanceof Error ? err.message : 'Unknown error'
          }`,
        );
      },
    );

    // Server-side conversion truth for analytics (covers webhook + admin
    // confirm). Detached like the invoice email: never blocks a confirmation.
    void this.webAnalytics.track({
      name: 'purchase',
      userId: payment.order.buyerId,
      props: {
        amount: payment.amount.toNumber(),
        orderId: payment.orderId,
        method: payment.method ?? undefined,
      },
    });

    this.logger.log(
      `Payment ${paymentId} confirmed for order group. Target order ${payment.orderId} status: ${result.targetOrderNewStatus}`,
    );

    return {
      payment: result.confirmed,
      orderPaymentStatus: result.targetOrderNewStatus,
      totalPaid: result.confirmedTotalPaid,
      totalAmount: payment.order.totalAmount.toNumber(),
    };
  }

  /**
   * Fires the seller-new-order notification for any order in the group that
   * was deferred at checkout (Order.sellersNotifiedAt still null) and has
   * now actually been paid for.
   *
   * The updateMany claim is the concurrency guard: it only affects rows that
   * are still null, and only the caller whose update actually matched a row
   * (count > 0) goes on to notify. That makes this safe to call from every
   * confirmPayment() path without a separate lock - a non-Razorpay order was
   * already stamped at checkout, so it never matches here at all; a
   * Razorpay-intent order matches at most once, no matter how many callers
   * (browser verify, webhook, admin) race to confirm the same payment.
   */
  private async notifyDeferredSellers(orderIds: string[]): Promise<void> {
    if (orderIds.length === 0) return;

    const candidates = await this.prisma.order.findMany({
      where: {
        id: { in: orderIds },
        sellersNotifiedAt: null,
        paymentStatus: PaymentStatus.SUCCESS,
      },
      select: {
        id: true,
        items: { select: { sellerId: true }, distinct: ['sellerId'] },
      },
    });

    for (const order of candidates) {
      const claimed = await this.prisma.order.updateMany({
        where: { id: order.id, sellersNotifiedAt: null },
        data: { sellersNotifiedAt: new Date() },
      });
      if (claimed.count === 0) continue;

      const pairs = order.items.map((item) => ({
        orderId: order.id,
        sellerId: item.sellerId,
      }));
      await this.sellerOrderNotifier.notifySellersOfNewOrder(pairs);
    }
  }

  // ──────────────────────────────────────────────
  // ADMIN: Reject a payment
  // ──────────────────────────────────────────────

  async rejectPayment(paymentId: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) {
      throw new NotFoundException('Payment not found');
    }

    if (payment.verificationStatus === PaymentVerificationStatus.REJECTED) {
      throw new BadRequestException('Payment is already rejected');
    }

    if (payment.verificationStatus === PaymentVerificationStatus.CONFIRMED) {
      throw new BadRequestException('Cannot reject a confirmed payment');
    }

    const rejected = await this.prisma.payment.update({
      where: { id: paymentId },
      data: { verificationStatus: PaymentVerificationStatus.REJECTED },
    });

    this.logger.log(`Payment ${paymentId} rejected`);
    return rejected;
  }

  // ──────────────────────────────────────────────
  // HELPER: Compute confirmed total for an order
  // ──────────────────────────────────────────────

  private async getConfirmedTotal(orderId: string): Promise<number> {
    const result = await this.prisma.payment.aggregate({
      where: {
        orderId,
        verificationStatus: PaymentVerificationStatus.CONFIRMED,
      },
      _sum: { amount: true },
    });
    return result._sum.amount?.toNumber() ?? 0;
  }

  // ──────────────────────────────────────────────
  // HELPER: Compute payment status from totals
  // ──────────────────────────────────────────────

  private computePaymentStatus(
    totalPaid: number,
    totalAmount: number,
  ): PaymentStatus {
    if (totalPaid >= totalAmount) return PaymentStatus.SUCCESS;
    if (totalPaid > 0) return PaymentStatus.PARTIAL;
    return PaymentStatus.PENDING;
  }

  // ──────────────────────────────────────────────
  // HELPER: Create seller settlements
  // ──────────────────────────────────────────────

  private async createSettlements(tx: any, items: any[]) {
    for (const item of items) {
      // Skip if settlement already exists for this order item
      const existing = await tx.sellerSettlement.findUnique({
        where: { orderItemId: item.id },
      });
      if (existing) continue;

      const sellerOffer = item.sellerOffer;
      const catalogProduct = sellerOffer?.variant?.catalogProduct;
      
      const baseSellingPrice = item.unitPrice;
      const quantity = item.quantity;
      const finalShippingPrice = sellerOffer?.finalShippingPrice ?? sellerOffer?.shippingCharges ?? 0;
      
      const commissionPercent = catalogProduct?.commissionPercent ?? 0;
      const commissionGstPercent = catalogProduct?.commissionGstPercent ?? 18;

      const breakdown = calculateSellerPayout({
        baseSellingPrice,
        quantity,
        finalShippingPrice,
        commissionPercent,
        commissionGstPercent,
      });

      await tx.sellerSettlement.create({
        data: {
          sellerId: item.sellerId,
          orderItemId: item.id,
          amount: breakdown.netPayout.toDecimalPlaces(2).toString(),
          grossAmount: breakdown.grossAmount.toString(),
          commission: breakdown.commission.toString(),
          commissionGst: breakdown.commissionGst.toString(),
          fixedFee: '0',
          fixedFeeGst: '0',
          withholdingTax: '0',
          netPayout: breakdown.netPayout.toString(),
          payoutStatus: breakdown.status,
        },
      });
    }

    this.logger.log(
      `Seller settlements created for ${items.length} order items`,
    );
  }
}
