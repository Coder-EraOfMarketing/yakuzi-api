import {
  Injectable,
  Logger,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import Razorpay from 'razorpay';
import {
  OrderStatus,
  PaymentMethod,
  PaymentStatus,
  PaymentVerificationStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { PaymentsService } from './payments.service';
import { VerifyRazorpayDto } from './dto/verify-razorpay.dto';
import { checkoutGroupWhere } from './checkout-group';

/**
 * Razorpay checkout.
 *
 * The buyer's order already exists by the time this runs; this covers taking the
 * money for it. Two steps, because that is how Razorpay works:
 *
 *   1. createOrder - we ask Razorpay for an order id and hand it to the browser.
 *   2. verifyPayment - the browser returns a signature, we check it here, and an
 *      unmodified signature is what marks the payment confirmed.
 *
 * The signature check is the whole security boundary. Everything the browser
 * sends after checkout is attacker-controlled, so nothing is trusted until the
 * HMAC computed with the key secret matches.
 */
@Injectable()
export class RazorpayService {
  private readonly logger = new Logger(RazorpayService.name);
  private client: Razorpay | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
    private readonly paymentsService: PaymentsService,
  ) {}

  private get keyId(): string | undefined {
    return this.configService.get<string>('RAZORPAY_KEY_ID');
  }

  private get keySecret(): string | undefined {
    return this.configService.get<string>('RAZORPAY_KEY_SECRET');
  }

  /** True when both keys are present, so callers can hide online payment cleanly. */
  isConfigured(): boolean {
    return Boolean(this.keyId && this.keySecret);
  }

  private getClient(): Razorpay {
    if (!this.keyId || !this.keySecret) {
      this.logger.warn(
        'Razorpay was called but RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET are not set',
      );
      throw new ServiceUnavailableException(
        'Online payment is not available right now.',
      );
    }
    if (!this.client) {
      this.client = new Razorpay({
        key_id: this.keyId,
        key_secret: this.keySecret,
      });
    }
    return this.client;
  }

  /**
   * Creates the Razorpay order for a checkout and records a pending payment
   * against it.
   *
   * The amount covers the WHOLE basket, not just the order whose id the browser
   * happened to send. A cart with items from three sellers becomes three orders
   * (see OrdersService.createOrder), and the buyer is quoted one total on the
   * checkout page — so charging one order's subtotal undercharged them and left
   * the other sellers' orders unpaid until the abandonment sweep cancelled them.
   *
   * The amount comes from those orders in our database, never from the client -
   * a caller-supplied amount would let a buyer pay one rupee for a large order.
   */
  async createOrder(userId: string, orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        buyerId: true,
        createdAt: true,
        checkoutGroupId: true,
        totalAmount: true,
        paymentStatus: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }
    if (order.buyerId !== userId) {
      throw new ForbiddenException('This order belongs to another account');
    }

    // Everything still owed from this checkout. A sibling that is already paid
    // or has since been cancelled is left out, so a retry after a partial
    // payment asks for the remainder and never for a cancelled order.
    const unpaid = await this.prisma.order.findMany({
      where: {
        ...checkoutGroupWhere(order),
        buyerId: userId,
        paymentStatus: { not: PaymentStatus.SUCCESS },
        orderStatus: { not: OrderStatus.CANCELLED },
      },
      select: { id: true, totalAmount: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!unpaid.length) {
      throw new BadRequestException('This order has already been paid');
    }

    const groupTotal = unpaid.reduce(
      (sum, o) => sum + Number(o.totalAmount),
      0,
    );
    const amountInPaise = Math.round(groupTotal * 100);
    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      throw new BadRequestException('This order has no amount to pay');
    }

    let razorpayOrder: { id: string };
    try {
      razorpayOrder = (await this.getClient().orders.create({
        amount: amountInPaise,
        currency: 'INR',
        // Our own id travels with the Razorpay order, so a payment can still be
        // traced back from their dashboard.
        receipt: order.id,
        // Every order this payment covers, so a multi-seller basket can be
        // reconciled from the Razorpay dashboard without a database lookup.
        notes: { orderId: order.id, orderIds: unpaid.map((o) => o.id).join(',') },
      })) as { id: string };
    } catch (err) {
      this.logger.error(
        `Razorpay refused to create an order for ${order.id}: ${
          err instanceof Error ? err.message : 'unknown error'
        }`,
      );
      throw new ServiceUnavailableException(
        'Could not start the payment. Please try again.',
      );
    }

    // Recorded before the buyer pays, so a payment that completes always has a
    // row waiting for it even if they close the tab immediately afterwards.
    //
    // The row is attached to the order the browser asked about and carries the
    // WHOLE basket's amount. That is the same shape a cash-on-delivery payment
    // already has, and it is what lets confirmPayment() mark every order in the
    // group paid — and what the webhook's amount check compares against.
    await this.prisma.payment.create({
      data: {
        orderId: order.id,
        amount: groupTotal,
        // There is no ONLINE method in the PaymentMethod enum, so adding one
        // would mean an enum migration on a live table. UPI is the closest
        // existing value; the Razorpay ids in referenceNumber are what
        // actually identify the payment.
        method: PaymentMethod.UPI,
        referenceNumber: razorpayOrder.id,
        verificationStatus: PaymentVerificationStatus.PENDING,
      },
    });

    return {
      razorpayOrderId: razorpayOrder.id,
      amount: amountInPaise,
      currency: 'INR',
      keyId: this.keyId,
      orderId: order.id,
    };
  }

  /**
   * Confirms a payment, but only if the signature Razorpay gave the browser
   * verifies against our key secret.
   */
  async verifyPayment(userId: string, dto: VerifyRazorpayDto) {
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = dto;

    const keySecret = this.keySecret;
    if (!keySecret) {
      throw new ServiceUnavailableException(
        'Online payment is not available right now.',
      );
    }

    const expected = crypto
      .createHmac('sha256', keySecret)
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest('hex');

    if (!this.signaturesMatch(expected, razorpaySignature)) {
      this.logger.warn(
        `Rejected a Razorpay signature for ${razorpayOrderId}`,
      );
      throw new BadRequestException('This payment could not be verified.');
    }

    // The signature proves Razorpay issued the pair. This lookup is what ties it
    // to one of OUR orders - without it a valid signature from any other payment
    // could be replayed against someone else's order.
    const payment = await this.prisma.payment.findFirst({
      where: { referenceNumber: { startsWith: razorpayOrderId } },
      include: { order: { select: { buyerId: true } } },
    });

    if (!payment) {
      throw new NotFoundException('No payment is pending for this order');
    }
    if (payment.order.buyerId !== userId) {
      throw new ForbiddenException('This payment belongs to another account');
    }

    // Checkout can call this more than once for the same payment; saying "done"
    // is better than failing a payment that already went through.
    if (payment.verificationStatus === PaymentVerificationStatus.CONFIRMED) {
      return { alreadyConfirmed: true, paymentId: payment.id };
    }

    // Both ids kept, so the payment is traceable in the Razorpay dashboard and a
    // refund can be issued against it later.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { referenceNumber: `${razorpayOrderId}|${razorpayPaymentId}` },
    });

    const result = await this.paymentsService.confirmPayment(payment.id);
    this.logger.log(
      `Confirmed Razorpay payment ${razorpayPaymentId} for order ${payment.orderId}`,
    );
    return result;
  }

  private get webhookSecret(): string | undefined {
    return this.configService.get<string>('RAZORPAY_WEBHOOK_SECRET');
  }

  /**
   * Server-to-server confirmation from Razorpay.
   *
   * The browser-side /verify call only happens if the buyer keeps the tab open
   * after paying. This is the path that cannot be skipped: Razorpay POSTs
   * payment.captured to us directly, so a buyer who pays and closes the tab
   * still gets their order confirmed instead of the money sitting unmatched
   * until someone reconciles by hand.
   *
   * Trust model mirrors verifyPayment: the HMAC over the RAW body (Razorpay
   * signs the exact bytes) proves Razorpay sent it, and the lookup against our
   * own Payment row ties it to one of our orders. The amount is additionally
   * checked against our order so even a signed event cannot confirm the wrong
   * figure.
   *
   * Return contract: a 2xx tells Razorpay to stop retrying, so every outcome
   * that a retry cannot fix (not ours, wrong amount, non-captured event)
   * acknowledges with handled:false and a log line. Only transport-level
   * problems (bad signature, no secret) and unexpected internal errors are
   * thrown - those are the cases where a retry is either an attack (drop it)
   * or genuinely worth repeating.
   */
  async handleWebhook(rawBody: Buffer | undefined, signature: string | undefined) {
    const secret = this.webhookSecret;
    if (!secret) {
      // The webhook should not be registered on the dashboard before the
      // secret is on this box; if it is, tell Razorpay to keep retrying
      // rather than silently swallowing real payment events.
      this.logger.warn(
        'Razorpay webhook was called but RAZORPAY_WEBHOOK_SECRET is not set',
      );
      throw new ServiceUnavailableException('Webhook is not configured.');
    }
    if (!rawBody || rawBody.length === 0) {
      throw new BadRequestException('Missing body');
    }

    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    if (!this.signaturesMatch(expected, signature ?? '')) {
      this.logger.warn('Rejected a Razorpay webhook: signature did not verify');
      throw new BadRequestException('This event could not be verified.');
    }

    let event: {
      event?: string;
      payload?: { payment?: { entity?: { id?: string; order_id?: string; amount?: number } } };
    };
    try {
      event = JSON.parse(rawBody.toString('utf8'));
    } catch {
      throw new BadRequestException('Body is not JSON');
    }

    if (event?.event !== 'payment.captured') {
      // Signed and well-formed, just not an event we act on.
      return { ok: true, handled: false };
    }

    const entity = event.payload?.payment?.entity;
    const razorpayOrderId = entity?.order_id;
    const razorpayPaymentId = entity?.id;
    if (!razorpayOrderId || !razorpayPaymentId) {
      this.logger.warn('payment.captured arrived without ids; acknowledged and skipped');
      return { ok: true, handled: false };
    }

    const payment = await this.prisma.payment.findFirst({
      where: { referenceNumber: { startsWith: razorpayOrderId } },
    });
    if (!payment) {
      // Real money moved but we have no row for it - most likely a payment
      // from before createOrder started writing rows, or another integration
      // on the same Razorpay account. Retrying will not create the row.
      this.logger.error(
        `payment.captured for unknown Razorpay order ${razorpayOrderId} (payment ${razorpayPaymentId}) - needs manual reconciliation`,
      );
      return { ok: true, handled: false };
    }

    if (payment.verificationStatus === PaymentVerificationStatus.CONFIRMED) {
      return { ok: true, handled: true, alreadyConfirmed: true };
    }

    const expectedPaise = Math.round(Number(payment.amount) * 100);
    if (typeof entity?.amount === 'number' && entity.amount !== expectedPaise) {
      // Signed by Razorpay yet the figure does not match our order. Never
      // auto-confirm a mismatched amount; leave it PENDING for an admin.
      this.logger.error(
        `payment.captured amount ${entity.amount} != expected ${expectedPaise} for payment ${payment.id} - left PENDING for admin review`,
      );
      return { ok: true, handled: false };
    }

    // Both ids kept, same as verifyPayment, so the payment stays traceable.
    await this.prisma.payment.update({
      where: { id: payment.id },
      data: { referenceNumber: `${razorpayOrderId}|${razorpayPaymentId}` },
    });

    try {
      await this.paymentsService.confirmPayment(payment.id);
    } catch (err) {
      // The browser's /verify can win the race between our status check and
      // this call; "already confirmed" is a success, not a failure.
      if (err instanceof BadRequestException) {
        return { ok: true, handled: true, alreadyConfirmed: true };
      }
      throw err;
    }

    this.logger.log(
      `Webhook confirmed Razorpay payment ${razorpayPaymentId} for order ${payment.orderId}`,
    );
    return { ok: true, handled: true };
  }

  /** Constant-time compare, so a wrong signature cannot be narrowed down by timing. */
  private signaturesMatch(expected: string, received: string): boolean {
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received || '', 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }
}
