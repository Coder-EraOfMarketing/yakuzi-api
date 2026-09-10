import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateShippingDetailsDto } from './dto/update-shipping-details.dto';
import { SelfShipTrackingDto } from './dto/self-ship-tracking.dto';
import { OrderStatus, Role, PaymentStatus, Prisma } from '@prisma/client';
import { ShiprocketService } from './shiprocket.service';
import { calculateSellerPayout, buildPayoutInputFromOrderItem } from '../settlements/payout-calculator';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from '../notifications/notifications.service';
import { OtpSmsService } from '../auth/services/otp-sms.service';
import { SellerOrderNotifierService } from './seller-order-notifier.service';
import { InventoryService } from '../products/services/inventory.service';
import { IntegrationEventsService } from '../integrations/integration-events.service';

/**
 * Fields a seller may still write once the admin has locked shipping.
 *
 * The lock freezes the package dimensions and their proof images so the admin
 * can generate the shipping label against figures that cannot change. The final
 * manifest and the packed-box picture are produced after that, so they stay
 * writable - otherwise the seller can never provide them.
 */
const SELLER_FINAL_DOCUMENT_FIELDS: string[] = [
  'manifestUrl',
  'packedPictureUrl',
];

/**
 * Document fields on updateAdminShippingDocs' dto. Used to tell an actual
 * document upload apart from a lock-only toggle (isShippingLocked with none
 * of these set), which must not trigger a "documents ready" seller email.
 */
const ADMIN_SHIPPING_DOC_FIELDS = [
  'adminShippingLabelUrl',
  'adminInvoiceUrl',
  'manifestUrl',
  'invoiceUrl',
] as const;

/**
 * Order.fulfillmentMode values. Snapshotted from the seller's selfShipEnabled
 * flag at checkout; the two flows are mutually exclusive per order.
 */
export const FULFILLMENT_MODE_SHIPROCKET = 'shiprocket';
export const FULFILLMENT_MODE_SELF_SHIP = 'self_ship';

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly shiprocketService: ShiprocketService,
    private readonly mailService: MailService,
    private readonly notificationsService: NotificationsService,
    private readonly otpSmsService: OtpSmsService,
    private readonly sellerOrderNotifier: SellerOrderNotifierService,
    // Appended, never inserted: several specs construct this service
    // positionally, so changing the existing order would break them silently.
    private readonly inventoryService: InventoryService,
    private readonly integrationEvents: IntegrationEventsService,
  ) {}

  // ──────────────────────────────────────────────
  // SHIPROCKET PUSH — shared by the seller and admin
  // status-update paths so both actually create the
  // Shiprocket shipment on the READY_TO_SHIP transition.
  // ──────────────────────────────────────────────

  /**
   * Idempotent: no-ops (returns {}) if the order already has a
   * shiprocketOrderId, or if the Shiprocket API call fails — a failed push
   * must never block the order status transition itself.
   */
  async pushOrderToShiprocketIfNeeded(order: {
    id: string;
    createdAt: Date;
    totalAmount: unknown;
    paymentStatus: PaymentStatus;
    shiprocketOrderId: string | null;
    fulfillmentMode?: string | null;
    packageLength?: number | null;
    packageBreadth?: number | null;
    packageHeight?: number | null;
    packageWeight?: number | null;
    address: {
      name?: string | null;
      address?: string | null;
      city?: string | null;
      pincode?: string | null;
      state?: string | null;
      phone?: string | null;
    } | null;
    buyer: {
      email?: string | null;
      phone?: string | null;
      buyerProfile?: { legalName?: string | null } | null;
    };
    items: Array<{
      quantity: number;
      unitPrice: unknown;
      sellerOffer: { id: string; name: string };
    }>;
  }): Promise<{
    shiprocketOrderId?: string;
    shipmentId?: string;
    awbCode?: string;
    courierName?: string;
  }> {
    if (order.shiprocketOrderId) {
      return {};
    }

    // Self-ship orders are fulfilled by the seller's own courier and must
    // never be pushed to Shiprocket, no matter which status-transition path
    // triggered the push attempt.
    if (order.fulfillmentMode === FULFILLMENT_MODE_SELF_SHIP) {
      return {};
    }

    // Real package dimensions come from the seller's own submission
    // (updateShippingDetails). Fall back to placeholder measurements only
    // if the seller hasn't submitted any yet, so admin is never blocked
    // from pushing an order — but log it, since the resulting label will
    // under/over-charge the actual courier cost.
    const hasRealDimensions =
      order.packageLength != null &&
      order.packageBreadth != null &&
      order.packageHeight != null &&
      order.packageWeight != null;

    if (!hasRealDimensions) {
      this.logger.warn(
        `Order ${order.id} pushed to Shiprocket without seller-submitted dimensions — using placeholder 10x10x10cm/1kg`,
      );
    }

    // Shiprocket rejects order creation outright (422) without a numeric HSN
    // per item, but the catalog has no HSN field on any product yet. This
    // placeholder only unblocks the push - it is NOT a real HSN and must not
    // be treated as tax-compliant. Real per-product HSN codes still need to
    // be added to the catalog before invoices generated from these orders
    // are GST-legal (see the existing GST/GSTIN invoice-legality gap).
    const PLACEHOLDER_HSN = '9999';
    this.logger.warn(
      `Order ${order.id} pushed to Shiprocket with placeholder HSN ${PLACEHOLDER_HSN} on all items — no product in the catalog has a real HSN code yet; do not treat resulting documents as tax-compliant`,
    );

    try {
      // The pickup-address nickname isn't configurable in code — Shiprocket's
      // UI only offers a fixed set of tags (Home/Work/Warehouse/Other), so a
      // hardcoded "Primary" silently matches nothing. Resolve whatever is
      // actually configured on the account instead.
      const pickupLocation =
        await this.shiprocketService.getPrimaryPickupLocation();

      const payload = {
        order_id: order.id,
        order_date: order.createdAt
          .toISOString()
          .replace('T', ' ')
          .substring(0, 16),
        pickup_location: pickupLocation,
        billing_customer_name:
          order.address?.name ||
          order.buyer.buyerProfile?.legalName ||
          'Buyer',
        billing_last_name: '',
        billing_address: order.address?.address || 'Address',
        billing_city: order.address?.city || 'City',
        billing_pincode: order.address?.pincode || '110001',
        billing_state: order.address?.state || 'State',
        billing_country: 'India',
        billing_email: order.buyer.email || 'no-reply@yukizi.com',
        billing_phone:
          order.buyer.phone || order.address?.phone || '9999999999',
        shipping_is_billing: true,
        order_items: order.items.map((item) => ({
          name: item.sellerOffer.name,
          sku: item.sellerOffer.id.substring(0, 8), // placeholder sku
          units: item.quantity,
          selling_price: item.unitPrice,
          discount: 0,
          tax: 0,
          hsn: PLACEHOLDER_HSN,
        })),
        payment_method: order.paymentStatus === 'SUCCESS' ? 'Prepaid' : 'COD',
        sub_total: order.totalAmount,
        length: order.packageLength ?? 10,
        breadth: order.packageBreadth ?? 10,
        height: order.packageHeight ?? 10,
        weight: order.packageWeight ?? 1,
      };

      const shiprocketData = await this.shiprocketService.createOrder(
        payload,
      );

      this.logger.log(
        `Order ${order.id} pushed to Shiprocket: ${shiprocketData.shipment_id}`,
      );

      return {
        shiprocketOrderId: shiprocketData.order_id?.toString(),
        shipmentId: shiprocketData.shipment_id?.toString(),
        awbCode: shiprocketData.awb_code?.toString(),
        courierName: shiprocketData.courier_name?.toString(),
      };
    } catch (error: any) {
      this.logger.error(
        `Failed to push order ${order.id} to Shiprocket: ${error.message}`,
      );
      // Not failing the status transition if Shiprocket fails; admin can
      // retry by re-triggering the transition (pushOrderToShiprocketIfNeeded
      // is idempotent on shiprocketOrderId being unset).
      return {};
    }
  }

  /**
   * Writes back AWB/courier from a live Shiprocket tracking response.
   * Called on every GET .../tracking poll so the values the admin sees stay
   * current even though Shiprocket only assigns them once a human manually
   * books the shipment and generates the AWB inside the Shiprocket dashboard
   * — there is no webhook wired up to push that assignment to us.
   */
  async syncTrackingFields(
    orderId: string,
    tracking: {
      awb_code?: string | null;
      courier?: string | null;
      track_url?: string | null;
    },
  ): Promise<void> {
    const data: {
      awbCode?: string;
      courierName?: string;
      trackingUrl?: string;
    } = {};
    if (tracking.awb_code) data.awbCode = tracking.awb_code;
    if (tracking.courier) data.courierName = tracking.courier;
    if (tracking.track_url) data.trackingUrl = tracking.track_url;
    if (Object.keys(data).length === 0) return;

    try {
      await this.prisma.order.update({ where: { id: orderId }, data });
    } catch (error: any) {
      this.logger.warn(
        `Failed to sync tracking fields for order ${orderId}: ${error.message}`,
      );
    }
  }

  /**
   * Statuses the buyer actually cares about hearing of, and what to call
   * each one — deliberately a subset of OrderStatus. PLACED/ACCEPTED/etc.
   * already have their own notification call sites elsewhere; this map only
   * covers the post-payment shipping journey.
   */
  private readonly BUYER_STATUS_UPDATES: Partial<
    Record<OrderStatus, { label: string; notifyInApp: (buyerId: string, orderId: string) => Promise<unknown> }>
  > = {
    [OrderStatus.DISPATCHED_FROM_SELLER]: {
      label: 'Dispatched',
      notifyInApp: (b, o) => this.notificationsService.notifyOrderDispatched(b, o),
    },
    [OrderStatus.SHIPPED]: {
      label: 'Shipped',
      notifyInApp: (b, o) => this.notificationsService.notifyOrderShipped(b, o),
    },
    [OrderStatus.OUT_FOR_DELIVERY]: {
      label: 'Out for Delivery',
      notifyInApp: (b, o) => this.notificationsService.notifyOrderOutForDelivery(b, o),
    },
    [OrderStatus.DELIVERED]: {
      label: 'Delivered',
      notifyInApp: (b, o) => this.notificationsService.notifyOrderDelivered(b, o),
    },
  };

  /**
   * Tells the buyer their order moved — in-app notification, email, and SMS
   * (SMS only if a DLT-approved transactional template is configured; see
   * OtpSmsService.sendTransactional). Each channel is independent and never
   * throws: a buyer with no email just skips that channel, a down mail
   * server never blocks the in-app notification, etc. Order status changes
   * must never fail because a notification channel had a bad day.
   */
  async notifyBuyerOfStatusChange(
    order: {
      id: string;
      buyerId: string;
      buyer: { email?: string | null; phone?: string | null };
    },
    status: OrderStatus,
  ): Promise<void> {
    const update = this.BUYER_STATUS_UPDATES[status];
    if (!update) return;

    const shortId = order.id.slice(0, 8).toUpperCase();

    try {
      await update.notifyInApp(order.buyerId, order.id);
    } catch (error: any) {
      this.logger.warn(
        `In-app notification failed for order ${order.id} (${status}): ${error.message}`,
      );
    }

    // The courier link, if there is one by now — pasted by a self-ship seller
    // or synced from Shiprocket. Read here rather than passed in: every caller
    // writes it moments before calling this, and threading it through all of
    // them would be four chances to forget one. Never fatal — if the read
    // fails the buyer still gets the mail, just without the link, exactly as
    // before.
    const shipment =
      status === OrderStatus.DELIVERED ? null : await this.shipmentLinkFor(order.id);
    const trackingUrl = shipment?.trackingUrl?.trim() || null;
    const courierName = shipment?.courierName?.trim() || null;

    if (order.buyer.email) {
      const detail: string[] = [];
      if (courierName) detail.push(`Courier: ${courierName}`);
      if (trackingUrl) detail.push(`Track your parcel: ${trackingUrl}`);

      const closing = detail.length
        ? 'You can also track it from the Orders section of your Yukizi account.'
        : 'You can track it anytime from the Orders section of your Yukizi account.';

      // courierName is free text the seller typed, and trackingUrl can come
      // from Shiprocket — both are escaped before they reach the markup.
      const htmlDetail =
        (courierName
          ? `<p style="margin:0 0 4px">Courier: <strong>${this.escape(courierName)}</strong></p>`
          : '') +
        (trackingUrl
          ? `<p style="margin:0 0 12px"><a href="${this.escape(trackingUrl)}">Track your parcel</a></p>`
          : '');

      const result = await this.mailService.sendMail({
        to: order.buyer.email,
        subject: `Your Yukizi order #${shortId} is ${update.label}`,
        text: [
          'Hi,',
          '',
          `Your order #${shortId} is now ${update.label}.`,
          ...(detail.length ? ['', ...detail] : []),
          '',
          closing,
          '',
          '— Team Yukizi',
        ].join('\n'),
        html: `<p>Hi,</p><p>Your order <strong>#${shortId}</strong> is now <strong>${update.label}</strong>.</p>${htmlDetail}<p>${closing}</p><p>— Team Yukizi</p>`,
      });
      if (!result.sent) {
        this.logger.warn(
          `Status-update email not sent for order ${order.id} (${status}), retryable=${result.retryable}`,
        );
      }
    }

    if (order.buyer.phone) {
      // Deliberately unchanged, and no tracking link here. Transactional SMS
      // goes out against a DLT-approved template (see
      // OtpSmsService.sendTransactional); editing the wording — or adding a
      // URL — risks the operator rejecting every message. The link lives in
      // the email.
      const result = await this.otpSmsService.sendTransactional(
        order.buyer.phone,
        `Your Yukizi order #${shortId} is now ${update.label}. Track it in the Yukizi app.`,
      );
      if (!result.success) {
        this.logger.warn(
          `Status-update SMS not sent for order ${order.id} (${status}): ${result.reason}`,
        );
      }
    }
  }

  // ──────────────────────────────────────────────
  // CHECKOUT  — Create Order from Cart
  // ──────────────────────────────────────────────

  /**
   * Fill in the buyer's phone and address from what they entered at checkout.
   *
   * Only fills blanks — anything the buyer has already saved is left alone, so
   * placing an order can never quietly rewrite their saved details.
   */
  /**
   * Queues an inventory push to every sales channel carrying these listings.
   *
   * Best-effort by design: `IntegrationEventsService.fanOutYukiziChange` only
   * creates job rows, so the actual channel calls happen in the background
   * runner with its own retries. A seller with no connected channels does no
   * work here beyond one indexed lookup per listing.
   */
  private async notifyChannelsOfStockChange(
    offers: { sellerId: string; sellerOfferId: string }[],
  ): Promise<void> {
    if (offers.length === 0) return;
    // Guarded so a test harness that constructs this service without the
    // integration dependencies still exercises checkout normally.
    if (!this.integrationEvents || !this.inventoryService) return;

    // One listing can appear on several lines of the same checkout.
    const unique = new Map<string, { sellerId: string; sellerOfferId: string }>();
    for (const offer of offers) unique.set(offer.sellerOfferId, offer);

    for (const offer of unique.values()) {
      const quantity = await this.inventoryService.getTotalStock(
        offer.sellerOfferId,
      );
      await this.integrationEvents.fanOutYukiziChange(
        offer.sellerId,
        offer.sellerOfferId,
        quantity,
      );
    }
  }

  private async syncBuyerContactDetails(userId: string, dto: CreateOrderDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        phone: true,
        email: true,
        buyerProfile: {
          select: {
            id: true,
            address: true,
            city: true,
            state: true,
            pincode: true,
          },
        },
      },
    });
    if (!user) return;

    const phone = dto.phone?.trim();
    if (!user.phone?.trim() && phone) {
      // User.phone is unique and doubles as a login identifier, so only claim
      // it when no other account holds it. Racing here would surface as P2002
      // and is swallowed by the caller.
      const takenBySomeoneElse = await this.prisma.user.findFirst({
        where: { phone, NOT: { id: userId } },
        select: { id: true },
      });
      if (!takenBySomeoneElse) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { phone },
        });
      }
    }

    const email = dto.email?.trim().toLowerCase();
    if (!user.email?.trim() && email) {
      // User.email is unique and is a login identifier, so only claim it when no
      // other account holds it — the same rule the phone above follows. An
      // existing address is never overwritten: it is a credential, not a
      // preference. Racing here surfaces as P2002 and is swallowed by the caller.
      const takenBySomeoneElse = await this.prisma.user.findFirst({
        where: { email, NOT: { id: userId } },
        select: { id: true },
      });
      if (!takenBySomeoneElse) {
        await this.prisma.user.update({
          where: { id: userId },
          data: { email },
        });
      }
    }

    const profile = user.buyerProfile;
    if (!profile) return;

    const existingAddress =
      profile.address && typeof profile.address === 'object'
        ? (profile.address as Record<string, unknown>)
        : {};
    const hasStreet =
      typeof existingAddress.street1 === 'string' &&
      existingAddress.street1.trim().length > 0;

    const data: Record<string, unknown> = {};

    const street = dto.address?.trim();
    if (!hasStreet && street) {
      // Shape matches what the profile screen reads: { street1, city, state, pincode }
      data.address = {
        ...existingAddress,
        street1: street,
        city: dto.city?.trim() ?? '',
        state: dto.state?.trim() ?? '',
        pincode: dto.pincode?.trim() ?? '',
      };
    }
    if (!profile.city?.trim() && dto.city?.trim()) data.city = dto.city.trim();
    if (!profile.state?.trim() && dto.state?.trim())
      data.state = dto.state.trim();
    if (!profile.pincode?.trim() && dto.pincode?.trim())
      data.pincode = dto.pincode.trim();

    if (Object.keys(data).length === 0) return;

    await this.prisma.buyerProfile.update({
      where: { id: profile.id },
      data,
    });
  }

  /**
   * Stops a checkout whose contact details belong to somebody else's account,
   * and says so, instead of taking the order and quietly ignoring them.
   *
   * User.phone and User.email are unique — they are login identifiers. When a
   * buyer has neither on file (a Google sign-in has no phone; a phone-OTP
   * sign-in has no email), checkout tries to claim what they type. If another
   * account already holds it the claim cannot happen, and until now the order
   * went through anyway: the buyer was never told, and their account stayed
   * blank.
   *
   * Only checked when the account does NOT already hold that detail. A buyer
   * with their own number on file is free to enter someone else's as the
   * delivery contact — sending a gift to a friend must keep working.
   */
  private async assertContactDetailsAreClaimable(
    userId: string,
    dto: CreateOrderDto,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { phone: true, email: true },
    });
    if (!user) return;

    const phone = dto.phone?.trim();
    if (!user.phone?.trim() && phone) {
      const taken = await this.prisma.user.findFirst({
        where: { phone, NOT: { id: userId } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          'This mobile number is already registered to another Yukizi account. ' +
            'Please use a different number, or sign in with that number instead.',
        );
      }
    }

    const email = dto.email?.trim().toLowerCase();
    if (!user.email?.trim() && email) {
      const taken = await this.prisma.user.findFirst({
        where: { email, NOT: { id: userId } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException(
          'This email address is already registered to another Yukizi account. ' +
            'Please use a different email, or sign in with that address instead.',
        );
      }
    }
  }

  async checkout(userId: string, dto: CreateOrderDto) {
    // Before anything is reserved or charged: if the details they typed belong
    // to someone else's account, tell them now rather than after payment.
    await this.assertContactDetailsAreClaimable(userId, dto);

    // 1. Fetch buyer cart with items + product + seller + batches
    const cart = await this.prisma.cart.findUnique({
      where: { userId },
      include: {
        items: {
          include: {
            sellerOffer: {
              include: {
                seller: {
                  select: {
                    id: true,
                    verificationStatus: true,
                    companyName: true,
                    selfShipEnabled: true,
                  },
                },
                batches: {
                  where: { stock: { gt: 0 } },
                  orderBy: { expiryDate: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (!cart || cart.items.length === 0) {
      throw new BadRequestException(
        'Cart is empty. Add products before checkout.',
      );
    }

    // 1b. Fetch buyer profile for referral code (KYC checks removed)
    const buyerProfile = await this.prisma.buyerProfile.findUnique({
      where: { userId },
      select: { referralCodeId: true },
    });

    // 2. Validate every cart item
    for (const item of cart.items) {
      const { sellerOffer: product } = item;

      if (!product.isActive || product.deletedAt) {
        throw new BadRequestException(
          `Product "${product.name}" is no longer available. Please remove it from your cart.`,
        );
      }

      const totalStock = product.batches.reduce((sum, b) => sum + b.stock, 0);
      if (item.quantity > totalStock) {
        throw new BadRequestException(
          `Insufficient stock for "${product.name}". Only ${totalStock} units available.`,
        );
      }

      // Charge the seller's CURRENT price, not whatever was snapshotted into
      // the cart item when it was added — a stale snapshot would let a buyer
      // complete checkout at a price the seller no longer offers.
      item.unitPrice = product.finalCustomerPayable ?? product.mrp;
    }

    // 3. Group cart items by seller
    const itemsBySeller = new Map<string, typeof cart.items>();
    for (const item of cart.items) {
      const sellerId = item.sellerOffer.seller.id;
      if (!itemsBySeller.has(sellerId)) {
        itemsBySeller.set(sellerId, []);
      }
      itemsBySeller.get(sellerId)!.push(item);
    }

    // Calculate total amount for all items in cart (for logging/summary)
    const totalAmount = cart.items.reduce(
      (sum, item) => sum + (item.quantity * Number(item.unitPrice)),
      0,
    );

    // 4. Execute transactional checkout (split by seller)
    const sellerOrderPairs: { orderId: string; sellerId: string }[] = [];
    // Listings whose stock this checkout reduces. Collected here so connected
    // sales channels can be told AFTER the transaction commits — a Yukizi sale
    // that never reaches Shopify/WooCommerce/Amazon is how a seller oversells
    // the same unit twice.
    const stockChangedOffers: { sellerId: string; sellerOfferId: string }[] = [];
    const order = await this.prisma.$transaction(async (tx) => {
      const createdOrders: any[] = [];

      for (const [sellerId, sellerItems] of itemsBySeller.entries()) {
        const sellerTotalAmount = sellerItems.reduce(
          (sum, item) => sum + (item.quantity * Number(item.unitPrice)),
          0,
        );

        // 4a. Create Order
        const newOrder = await tx.order.create({
          data: {
            buyerId: userId,
            totalAmount: sellerTotalAmount,
            orderStatus: OrderStatus.PLACED,
            // Snapshot the seller's fulfillment preference at this moment -
            // toggling selfShipEnabled later must not change existing orders.
            fulfillmentMode: sellerItems[0].sellerOffer.seller.selfShipEnabled
              ? FULFILLMENT_MODE_SELF_SHIP
              : FULFILLMENT_MODE_SHIPROCKET,
            referralCodeId: buyerProfile?.referralCodeId || null,
            // Razorpay-intent checkouts ask to hold off telling sellers until
            // the payment actually succeeds (see Order.sellersNotifiedAt) -
            // stamped now for every other method, matching today's behavior
            // of notifying immediately at checkout.
            sellersNotifiedAt: dto.deferSellerNotification ? null : new Date(),
          },
        });

        // 4b. Create OrderItems
        const orderItemsData = sellerItems.map((item) => ({
          orderId: newOrder.id,
          sellerOfferId: item.sellerOfferId,
          sellerId: sellerId,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: item.quantity * Number(item.unitPrice),
        }));

        await tx.orderItem.createMany({ data: orderItemsData });

        // 4c. Create OrderAddress snapshot
        await tx.orderAddress.create({
          data: {
            orderId: newOrder.id,
            name: dto.name,
            phone: dto.phone,
            address: dto.address,
            city: dto.city,
            state: dto.state,
            pincode: dto.pincode,
          },
        });

        // 4d. Reduce ProductBatch stock (FIFO — earliest expiry first)
        for (const item of sellerItems) {
          let remaining = item.quantity;

          for (const batch of item.sellerOffer.batches) {
            if (remaining <= 0) break;

            const deduct = Math.min(remaining, batch.stock);
            await tx.productBatch.update({
              where: { id: batch.id },
              data: { stock: { decrement: deduct } },
            });
            remaining -= deduct;
          }

          stockChangedOffers.push({ sellerId, sellerOfferId: item.sellerOffer.id });
        }

        createdOrders.push(newOrder);
        sellerOrderPairs.push({ orderId: newOrder.id, sellerId });
      }

      // 4e. Clear buyer cart
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      return createdOrders[0];
    });

    // 4f. Notify each seller in the cart that they have a new order to
    // process — both the in-app bell and, when they have an address on
    // file, an email. Deliberately outside the transaction and never
    // rethrown: a notification failing must never roll back or fail an
    // order the buyer has already placed.
    //
    // Skipped entirely for a deferred (Razorpay-intent) checkout - nothing
    // to tell a seller about an order nobody has paid for yet.
    // PaymentsService.confirmPayment() sends this same notification once the
    // payment actually succeeds.
    if (!dto.deferSellerNotification) {
      await this.sellerOrderNotifier
        .notifySellersOfNewOrder(sellerOrderPairs)
        .catch((err) => {
          this.logger.warn(
            `Could not notify sellers of new order(s) for checkout by user ${userId}: ${
              err instanceof Error ? err.message : 'Unknown error'
            }`,
          );
        });
    }

    // 4f-bis. Tell the seller's connected sales channels that this stock has
    // moved. Without it a unit sold on Yukizi stays "available" on Shopify,
    // WooCommerce and Amazon until the next hourly sweep, which is long enough
    // to sell it again.
    //
    // Deliberately outside the transaction and never rethrown, for the same
    // reason as the notifications above: the buyer has already placed this
    // order, and a channel being unreachable must not fail it.
    await this.notifyChannelsOfStockChange(stockChangedOffers).catch((err) => {
      this.logger.warn(
        `Could not queue channel inventory updates for checkout by user ${userId}: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`,
      );
    });

    // 4g. Carry the checkout details onto the buyer's profile.
    // The buyer types a phone number and address at checkout, but nothing ever
    // copied them anywhere, so "Edit profile" kept offering "Add your phone"
    // and "Add your address" no matter how many orders they had placed.
    // Deliberately outside the transaction and never rethrown: this is a
    // convenience, and it must not be able to roll back an order that the
    // buyer has already paid for and seen confirmed.
    await this.syncBuyerContactDetails(userId, dto).catch((err) => {
      this.logger.warn(
        `Could not copy checkout details to the buyer profile for user ${userId}: ${
          err instanceof Error ? err.message : 'Unknown error'
        }`,
      );
    });

    // 5. Fetch the created order with full details
    const fullOrder = await this.prisma.order.findUnique({
      where: { id: order.id },
      include: {
        items: {
          include: {
            sellerOffer: {
              select: {
                id: true,
                name: true,
                manufacturer: true,
                mrp: true,
                variant: {
                  select: {
                    catalogProduct: {
                      select: {
                        images: {
                          select: { url: true },
                          orderBy: [{ order: 'asc' }, { id: 'asc' }],
                        },
                      },
                    },
                  },
                },
              },
            },
            seller: {
              select: {
                id: true,
                companyName: true,
                city: true,
                state: true,
              },
            },
          },
        },
        address: true,
      },
    });

    if (fullOrder) {
      for (const item of fullOrder.items) {
        if (item.sellerOffer && !item.sellerOffer.variant) {
          const cleanName = item.sellerOffer.name.replace(/\.\.\./g, '').trim();
          const catalogProduct = await this.prisma.catalogProduct.findFirst({
            where: {
              name: {
                startsWith: cleanName,
                mode: 'insensitive',
              },
              deletedAt: null,
            },
            include: {
              images: {
                select: { url: true },
                orderBy: [{ order: 'asc' }, { id: 'asc' }],
              },
            },
          });
          if (catalogProduct && catalogProduct.images.length > 0) {
            (item.sellerOffer as any).variant = {
              catalogProduct: {
                images: catalogProduct.images,
              },
            };
          }
        }
      }
    }

    this.logger.log(
      `Order ${order.id} placed by user ${userId} — total ₹${totalAmount}`,
    );

    return fullOrder;
  }

  // ──────────────────────────────────────────────
  // GET BUYER ORDERS
  // ──────────────────────────────────────────────

  async getBuyerOrders(userId: string) {
    const orders = await this.prisma.order.findMany({
      where: { buyerId: userId },
      include: {
        items: {
          include: {
            sellerOffer: {
              select: {
                id: true,
                name: true,
                manufacturer: true,
                mrp: true,
                variant: {
                  select: {
                    catalogProduct: {
                      select: {
                        images: {
                          select: { url: true },
                          orderBy: [{ order: 'asc' }, { id: 'asc' }],
                        },
                      },
                    },
                  },
                },
              },
            },
            seller: {
              select: { id: true, companyName: true },
            },
          },
        },
        address: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    // Fallback: Populate images if variant is null (e.g. unlinked custom/temporary offers)
    for (const order of orders) {
      for (const item of order.items) {
        if (item.sellerOffer && !(item.sellerOffer as any).variant) {
          const cleanName = (item.sellerOffer as any).name
            .replace(/\.\.\./g, '')
            .trim();
          const catalogProduct = await this.prisma.catalogProduct.findFirst({
            where: {
              name: {
                startsWith: cleanName,
                mode: 'insensitive',
              },
              deletedAt: null,
            },
            include: {
              images: {
                select: { url: true },
                orderBy: [{ order: 'asc' }, { id: 'asc' }],
              },
            },
          });
          if (catalogProduct && catalogProduct.images.length > 0) {
            (item.sellerOffer as any).variant = {
              catalogProduct: {
                images: catalogProduct.images,
              },
            };
          }
        }
      }
    }

    return orders;
  }

  // ──────────────────────────────────────────────
  // GET ORDER DETAIL (Buyer)
  // ──────────────────────────────────────────────

  async getOrderDetail(userId: string, orderId: string) {
    // 1. Identify user roles and profiles
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true, sellerProfile: { select: { id: true } } },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    // 2. Fetch the order
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            sellerOffer: {
              select: {
                id: true,
                name: true,
                manufacturer: true,
                mrp: true,
                gstPercent: true,
                shippingCharges: true,
                finalShippingPrice: true,
                discountType: true,
                discountMeta: true,
                isTaxIncluded: true,
                catalogProduct: {
                  select: {
                    commissionPercent: true,
                    commissionGstPercent: true,
                    images: {
                      select: { url: true },
                      orderBy: [{ order: 'asc' }, { id: 'asc' }],
                    },
                    category: {
                      select: {
                        commissionPercent: true,
                        commissionGstPercent: true,
                      },
                    },
                    subCategory: {
                      select: {
                        commissionPercent: true,
                        commissionGstPercent: true,
                      },
                    },
                  },
                },
                variant: {
                  select: {
                    name: true,
                    sku: true,
                    catalogProduct: {
                      select: {
                        commissionPercent: true,
                        commissionGstPercent: true,
                        images: {
                          select: { url: true },
                          orderBy: [{ order: 'asc' }, { id: 'asc' }],
                        },
                        category: {
                          select: {
                            commissionPercent: true,
                            commissionGstPercent: true,
                          },
                        },
                        subCategory: {
                          select: {
                            commissionPercent: true,
                            commissionGstPercent: true,
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
            seller: {
              select: {
                id: true,
                companyName: true,
                city: true,
                state: true,
                rating: true,
              },
            },
            settlement: {
              select: {
                id: true,
                payoutStatus: true,
                payoutReference: true,
                paymentProofUrl: true,
                payoutDate: true,
              },
            },
          },
        },
        address: true,
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Fallback: Populate images if variant is null
    for (const item of order.items) {
      if (item.sellerOffer && !item.sellerOffer.variant) {
        const cleanName = item.sellerOffer.name.replace(/\.\.\./g, '').trim();
        const catalogProduct = await this.prisma.catalogProduct.findFirst({
          where: {
            name: {
              startsWith: cleanName,
              mode: 'insensitive',
            },
            deletedAt: null,
          },
          include: {
            images: {
              select: { url: true },
              orderBy: [{ order: 'asc' }, { id: 'asc' }],
            },
          },
        });
        if (catalogProduct && catalogProduct.images.length > 0) {
          (item.sellerOffer as any).variant = {
            catalogProduct: {
              images: catalogProduct.images,
            },
          };
        }
      }
    }

    // 3. Permission logic
    let hasAccess = false;

    // A. Role-based check
    if (user.role === Role.ADMIN) {
      hasAccess = true;
    } else if (user.role === Role.BUYER && order.buyerId === userId) {
      hasAccess = true;
    } else if (user.role === Role.SELLER && user.sellerProfile) {
      const sellerId = user.sellerProfile.id;
      // Check if this seller has ANY item in the order
      const hasSellerItem = order.items.some(
        (item) => item.sellerId === sellerId,
      );
      if (hasSellerItem) {
        hasAccess = true;
        // Multi-Seller Isolation: Filter order items so seller ONLY sees their own products
        order.items = order.items.filter((item) => item.sellerId === sellerId);

        // Dynamically copy the shipping details from the first item of this seller onto the parent order
        const firstItem = order.items[0];
        if (firstItem) {
          order.packageLength = firstItem.packageLength;
          order.packageBreadth = firstItem.packageBreadth;
          order.packageHeight = firstItem.packageHeight;
          order.packageWeight = firstItem.packageWeight;
          order.lengthImage = firstItem.lengthImage;
          order.breadthImage = firstItem.breadthImage;
          order.heightImage = firstItem.heightImage;
          order.weightImage = firstItem.weightImage;
          order.invoiceUrl = firstItem.invoiceUrl;
          order.manifestUrl = firstItem.manifestUrl;
          order.adminShippingLabelUrl = firstItem.adminShippingLabelUrl;
          order.adminInvoiceUrl = firstItem.adminInvoiceUrl;
          order.packedPictureUrl = firstItem.packedPictureUrl;
          order.isShippingLocked = firstItem.isShippingLocked;
        }
      }
    }

    if (!hasAccess) {
      throw new NotFoundException('Order not found');
    }

    const items = order.items.map((item: any) => {
      let estimatedPayout: any = null;
      if (item.settlement) {
        const comm = Number(item.settlement.commission || 0);
        const commGst = Number(item.settlement.commissionGst || 0);
        const ship = Number(item.sellerOffer?.finalShippingPrice ?? item.sellerOffer?.shippingCharges ?? 0);
        const net = Number(item.settlement.netPayout || item.settlement.amount || 0);
        const gross = Number(item.settlement.grossAmount || item.totalPrice || 0);
        const catalogProd = item.sellerOffer?.catalogProduct ?? item.sellerOffer?.variant?.catalogProduct;
        const commissionPercent = Number(
          catalogProd?.commissionPercent ??
          catalogProd?.subCategory?.commissionPercent ??
          catalogProd?.category?.commissionPercent ??
          item.sellerOffer?.commissionPercent ??
          0
        );
        const commissionGstPercent = Number(
          catalogProd?.commissionGstPercent ??
          catalogProd?.subCategory?.commissionGstPercent ??
          catalogProd?.category?.commissionGstPercent ??
          item.sellerOffer?.commissionGstPercent ??
          18
        );
        estimatedPayout = {
          grossAmount: gross,
          commission: comm,
          commissionGst: commGst,
          finalShippingPrice: ship,
          totalDeductions: comm + commGst + ship,
          netPayout: net,
          commissionPercent,
          commissionGstPercent,
          status: item.settlement.payoutStatus,
          isLedgered: true,
        };
      } else {
        const input = buildPayoutInputFromOrderItem(item);
        const breakdown = calculateSellerPayout(input);
        estimatedPayout = {
          grossAmount: breakdown.grossAmount.toNumber(),
          commission: breakdown.commission.toNumber(),
          commissionGst: breakdown.commissionGst.toNumber(),
          finalShippingPrice: breakdown.finalShippingPrice.toNumber(),
          totalDeductions: breakdown.totalDeductions.toNumber(),
          netPayout: breakdown.netPayout.toNumber(),
          commissionPercent: input.commissionPercent,
          commissionGstPercent: input.commissionGstPercent,
          status: breakdown.status,
          isLedgered: false,
        };
      }
      return {
        ...item,
        estimatedPayout,
      };
    });

    return {
      ...order,
      items,
    };
  }

  // ──────────────────────────────────────────────
  // GET SELLER ORDERS
  // ──────────────────────────────────────────────

  async getSellerOrders(userId: string, dateFrom?: string, dateTo?: string) {
    // Find seller profile
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { userId },
    });

    if (!seller) {
      throw new NotFoundException('Seller profile not found');
    }

    const where: any = {
      sellerId: seller.id,
      // Product decision (Rishi, 2026-08-24): sellers see ALL their orders,
      // including payment-pending ones, matching what admin sees. Payment-first
      // safety is enforced where it matters instead: notifications stay
      // deferred until payment succeeds (sellersNotifiedAt, unchanged), and
      // updateShippingDetails rejects unpaid orders so one can never be
      // accepted/shipped before the buyer pays.
      order: {},
    };

    if (dateFrom || dateTo) {
      where.order.createdAt = {};
      if (dateFrom) where.order.createdAt.gte = new Date(dateFrom);
      if (dateTo) where.order.createdAt.lte = new Date(dateTo);
    }

    // Fetch order items belonging to this seller, grouped by order
    const orderItems = await this.prisma.orderItem.findMany({
      where,
      include: {
        sellerOffer: {
          select: {
            id: true,
            name: true,
            manufacturer: true,
            mrp: true,
            variant: {
              select: {
                catalogProduct: {
                  select: {
                    images: {
                      select: { url: true },
                      orderBy: [{ order: 'asc' }, { id: 'asc' }],
                    },
                  },
                },
              },
            },
          },
        },
        order: {
          select: {
            id: true,
            buyerId: true,
            orderStatus: true,
            paymentStatus: true,
            createdAt: true,
            address: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group items by orderId for a cleaner response
    const ordersMap = new Map<
      string,
      {
        orderId: string;
        orderStatus: string;
        paymentStatus: string;
        createdAt: Date;
        address: any;
        items: any[];
        sellerTotal: number;
      }
    >();

    for (const item of orderItems) {
      const key = item.order.id;
      if (!ordersMap.has(key)) {
        ordersMap.set(key, {
          orderId: item.order.id,
          orderStatus: item.order.orderStatus,
          paymentStatus: item.order.paymentStatus,
          createdAt: item.order.createdAt,
          address: item.order.address,
          items: [],
          sellerTotal: 0,
        });
      }
      const entry = ordersMap.get(key)!;
      entry.items.push({
        id: item.id,
        product: item.sellerOffer,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
      });
      entry.sellerTotal += Number(item.totalPrice);
    }

    return Array.from(ordersMap.values());
  }

  // ──────────────────────────────────────────────
  // UPDATE ORDER STATUS (Seller)
  // ──────────────────────────────────────────────

  async updateOrderStatus(
    userId: string,
    orderId: string,
    dto: UpdateOrderStatusDto,
  ) {
    // 1. Find seller profile
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { userId },
    });

    if (!seller) {
      throw new NotFoundException('Seller profile not found');
    }

    // 2. Verify this seller has items in the order
    const sellerItems = await this.prisma.orderItem.findMany({
      where: { orderId, sellerId: seller.id },
    });

    if (sellerItems.length === 0) {
      throw new ForbiddenException('You do not have any items in this order');
    }

    // 3. Fetch current order
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        buyer: {
          select: {
            phone: true,
            email: true,
            buyerProfile: { select: { legalName: true } },
          },
        },
        address: true,
        items: {
          include: { sellerOffer: true },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // 4. Validate status transition
    // PAYMENT_RECEIVED and RECEIVED_AT_WAREHOUSE were removed from the
    // pipeline (2026-08-23 spec) — they remain valid SOURCE states so
    // legacy orders sitting in them can still progress, but nothing may
    // transition INTO them anymore.
    const validTransitions: Record<string, string[]> = {
      PLACED: ['ACCEPTED', 'CANCELLED'],
      ACCEPTED: ['READY_TO_SHIP', 'CANCELLED'],
      PAYMENT_RECEIVED: [
        'READY_TO_SHIP',
        'DISPATCHED_FROM_SELLER',
        'CANCELLED',
      ],
      READY_TO_SHIP: ['DISPATCHED_FROM_SELLER', 'CANCELLED'],
      DISPATCHED_FROM_SELLER: ['SHIPPED', 'CANCELLED'],
      RECEIVED_AT_WAREHOUSE: ['SHIPPED', 'CANCELLED'],
      SHIPPED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
      OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
      DELIVERED: ['RETURNED', 'CANCELLED'],
    };

    const allowed = validTransitions[order.orderStatus] ?? [];
    if (!allowed.includes(dto.status)) {
      throw new BadRequestException(
        `Cannot transition from ${order.orderStatus} to ${dto.status}. Allowed: ${allowed.join(', ') || 'none'}`,
      );
    }

    // 5. Update order status
    if (dto.status === OrderStatus.CANCELLED) {
      return this.cancelOrder(userId, orderId, Role.SELLER);
    }

    const updateData: any = { orderStatus: dto.status as OrderStatus };

    // Push to Shiprocket if status is READY_TO_SHIP and it hasn't been pushed yet
    if (dto.status === OrderStatus.READY_TO_SHIP) {
      Object.assign(
        updateData,
        await this.pushOrderToShiprocketIfNeeded(order),
      );
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
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
        address: true,
      },
    });

    await this.notifyBuyerOfStatusChange(
      { id: order.id, buyerId: order.buyerId, buyer: order.buyer },
      dto.status,
    );

    await this.createSettlementsForDeliveredOrder(updated);

    this.logger.log(
      `Order ${orderId} status updated to ${dto.status} by seller ${seller.id}`,
    );

    return updated;
  }

  async createSettlementsForDeliveredOrder(order: {
    orderStatus: OrderStatus;
    paymentStatus: PaymentStatus;
    items: Array<{
      id: string;
      sellerId: string;
      unitPrice: Prisma.Decimal | number;
      quantity: number;
      sellerOffer?: {
        finalShippingPrice?: Prisma.Decimal | number | null;
        shippingCharges?: Prisma.Decimal | number | null;
        variant?: {
          catalogProduct?: {
            commissionPercent?: Prisma.Decimal | number | null;
            commissionGstPercent?: Prisma.Decimal | number | null;
          } | null;
        } | null;
      } | null;
    }>;
  }): Promise<void> {
    if (
      order.orderStatus !== OrderStatus.DELIVERED ||
      order.paymentStatus !== PaymentStatus.SUCCESS
    ) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      for (const item of order.items) {
        const existing = await tx.sellerSettlement.findUnique({
          where: { orderItemId: item.id },
        });
        if (!existing) {
          const sellerOffer = item.sellerOffer;
          const catalogProduct = sellerOffer?.variant?.catalogProduct;

          const baseSellingPrice = Number(item.unitPrice);
          const quantity = item.quantity;
          const finalShippingPrice = item.sellerOffer?.finalShippingPrice
            ? Number(item.sellerOffer.finalShippingPrice)
            : item.sellerOffer?.shippingCharges
              ? Number(item.sellerOffer.shippingCharges)
              : 0;

          const commissionPercent = catalogProduct?.commissionPercent
            ? Number(catalogProduct.commissionPercent)
            : 0;
          const commissionGstPercent = catalogProduct?.commissionGstPercent
            ? Number(catalogProduct.commissionGstPercent)
            : 18;

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
      }
    });
  }

  // ──────────────────────────────────────────────
  // UPDATE SHIPPING DETAILS (Seller)
  // ──────────────────────────────────────────────

  async updateShippingDetails(
    userId: string,
    orderId: string,
    dto: UpdateShippingDetailsDto,
  ) {
    // 1. Find seller profile
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { userId },
    });

    if (!seller) {
      throw new NotFoundException('Seller profile not found');
    }

    // 2. Verify this seller has items in the order
    const sellerItems = await this.prisma.orderItem.findMany({
      where: { orderId, sellerId: seller.id },
    });

    if (sellerItems.length === 0) {
      throw new ForbiddenException('You do not have any items in this order');
    }

    // Sellers can now SEE unpaid orders in their portal (product decision,
    // 2026-08-24) — but submitting shipping details is the acceptance signal
    // that auto-advances the order and pushes it to Shiprocket, so it must
    // stay impossible until the buyer has actually paid.
    const orderRow = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { paymentStatus: true, fulfillmentMode: true },
    });
    if (!orderRow) {
      throw new NotFoundException('Order not found');
    }
    // Self-ship orders never go through the measurements/Shiprocket flow -
    // the seller submits a tracking link via submitSelfShipTracking instead.
    if (orderRow.fulfillmentMode === FULFILLMENT_MODE_SELF_SHIP) {
      throw new ForbiddenException(
        'This order uses self-ship fulfillment — submit your courier tracking link instead of shipping details.',
      );
    }
    if (
      orderRow.paymentStatus === PaymentStatus.PENDING ||
      orderRow.paymentStatus === PaymentStatus.FAILED
    ) {
      throw new ForbiddenException(
        'This order has not been paid yet — shipping details can be added once payment is received.',
      );
    }

    // 3. Check if shipping is locked for this seller's items.
    //
    // The lock exists so the admin can freeze the package dimensions and proof
    // images before generating the shipping label. Uploading the final manifest
    // and the packed-box picture happens AFTER that point, so blocking those two
    // fields as well left the seller with no way to ever supply them: the portal
    // hides the upload controls and this endpoint rejects the write.
    //
    // Dimensions and proofs stay frozen; the final documents remain accepted.
    const isLocked = sellerItems.some((item) => item.isShippingLocked);
    if (isLocked) {
      const submittedFields = Object.keys(dto).filter(
        (key) => (dto as Record<string, unknown>)[key] !== undefined,
      );
      const frozenFields = submittedFields.filter(
        (key) => !SELLER_FINAL_DOCUMENT_FIELDS.includes(key),
      );

      if (frozenFields.length > 0) {
        throw new ForbiddenException(
          `Shipping details are locked by admin. Only ${SELLER_FINAL_DOCUMENT_FIELDS.join(
            ' and ',
          )} can still be updated (rejected: ${frozenFields.join(', ')}).`,
        );
      }
    }

    // 4. Update all order items for this seller in this order
    await this.prisma.orderItem.updateMany({
      where: { orderId, sellerId: seller.id },
      data: dto as any,
    });

    // Also update the parent order table for compatibility/fallback
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: dto,
    });

    this.logger.log(
      `Order ${orderId} shipping details updated by seller ${seller.id}`,
    );

    // Best-effort, same contract as SellersService.emailAdminNewSeller: a
    // mail failure here must never fail the seller's save.
    await this.emailAdminShippingDetailsSubmitted(orderId, seller);

    // Submitting shipping details IS the seller's acceptance signal:
    // advance PLACED -> ACCEPTED (guarded updateMany so a concurrent
    // admin change — e.g. a cancellation — always wins), then push the
    // order to Shiprocket immediately with the real dimensions just
    // saved. The admin schedules the pickup inside Shiprocket's
    // dashboard; from there the 30-min poller drives READY_TO_SHIP and
    // every later stage. A failure in any of this must never block the
    // shipping-details save itself.
    try {
      const accepted = await this.prisma.order.updateMany({
        where: { id: orderId, orderStatus: OrderStatus.PLACED },
        data: { orderStatus: OrderStatus.ACCEPTED },
      });

      if (accepted.count > 0) {
        const forNotify = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: {
            id: true,
            buyerId: true,
            buyer: { select: { email: true, phone: true } },
          },
        });
        if (forNotify) {
          await this.notifyBuyerOfStatusChange(
            forNotify,
            OrderStatus.ACCEPTED,
          );
        }
      }

      const forPush = await this.prisma.order.findUnique({
        where: { id: orderId },
        include: {
          address: true,
          buyer: { include: { buyerProfile: true } },
          items: { include: { sellerOffer: true } },
        },
      });
      if (forPush) {
        const shiprocketFields =
          await this.pushOrderToShiprocketIfNeeded(forPush);
        if (Object.keys(shiprocketFields).length > 0) {
          await this.prisma.order.update({
            where: { id: orderId },
            data: shiprocketFields,
          });
        }
      }
    } catch (error: any) {
      this.logger.error(
        `Post-shipping-details auto-accept/Shiprocket push failed for order ${orderId}: ${error.message}`,
      );
    }

    return updated;
  }

  // ──────────────────────────────────────────────
  // SELF-SHIP TRACKING (Seller)
  // ──────────────────────────────────────────────

  /**
   * A self-ship seller submits (or later edits) the courier tracking link for
   * their order. First submission stamps shippedAt and advances the order to
   * SHIPPED — the same status the Shiprocket flow reaches via its sync — so
   * everything downstream of "shipped" behaves identically for both modes.
   * Later submissions only edit trackingUrl/courierName.
   */
  async submitSelfShipTracking(
    userId: string,
    orderId: string,
    dto: SelfShipTrackingDto,
  ) {
    const seller = await this.prisma.sellerProfile.findUnique({
      where: { userId },
      select: { id: true, companyName: true },
    });

    if (!seller) {
      throw new NotFoundException('Seller profile not found');
    }

    const sellerItems = await this.prisma.orderItem.findMany({
      where: { orderId, sellerId: seller.id },
      select: { id: true },
    });

    if (sellerItems.length === 0) {
      throw new ForbiddenException('You do not have any items in this order');
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        buyerId: true,
        fulfillmentMode: true,
        paymentStatus: true,
        orderStatus: true,
        shippedAt: true,
        buyer: { select: { email: true, phone: true } },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.fulfillmentMode !== FULFILLMENT_MODE_SELF_SHIP) {
      throw new ForbiddenException(
        'This order is fulfilled via the platform shipping flow — self-ship tracking does not apply.',
      );
    }

    // Same bar as updateShippingDetails: shipping anything before the buyer
    // has paid must stay impossible.
    if (
      order.paymentStatus === PaymentStatus.PENDING ||
      order.paymentStatus === PaymentStatus.FAILED
    ) {
      throw new ForbiddenException(
        'This order has not been paid yet — tracking can be submitted once payment is received.',
      );
    }

    if (
      order.orderStatus === OrderStatus.CANCELLED ||
      order.orderStatus === OrderStatus.RETURNED
    ) {
      throw new ForbiddenException('This order can no longer be shipped.');
    }

    const isFirstSubmit = order.shippedAt == null;

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        trackingUrl: dto.trackingUrl,
        ...(dto.courierName !== undefined
          ? { courierName: dto.courierName }
          : {}),
        ...(isFirstSubmit ? { shippedAt: new Date() } : {}),
      },
    });

    if (isFirstSubmit) {
      // Guarded on the not-yet-shipped statuses so a concurrent admin change
      // (e.g. a cancellation between the read above and this write) always
      // wins — mirrors updateShippingDetails' auto-accept updateMany.
      const advanced = await this.prisma.order.updateMany({
        where: {
          id: orderId,
          orderStatus: {
            in: [
              OrderStatus.PLACED,
              OrderStatus.ACCEPTED,
              OrderStatus.PAYMENT_RECEIVED,
              OrderStatus.READY_TO_SHIP,
              OrderStatus.DISPATCHED_FROM_SELLER,
              OrderStatus.RECEIVED_AT_WAREHOUSE,
            ],
          },
        },
        data: { orderStatus: OrderStatus.SHIPPED },
      });

      if (advanced.count > 0) {
        await this.notifyBuyerOfStatusChange(
          { id: order.id, buyerId: order.buyerId, buyer: order.buyer },
          OrderStatus.SHIPPED,
        );
      }
    }

    this.logger.log(
      `Order ${orderId} self-ship tracking ${isFirstSubmit ? 'submitted' : 'updated'} by seller ${seller.id}`,
    );

    // Admin needs to know a self-ship seller has dispatched — there is no
    // Shiprocket record for these, so this email is the only signal. Awaited
    // but never allowed to throw: a mail failure must not fail the seller's
    // tracking submission (same contract as the shipping-details email).
    await this.emailAdminSelfShipTracking(orderId, seller, dto.trackingUrl, dto.courierName, isFirstSubmit).catch(
      (error: unknown) => {
        this.logger.warn(
          `self-ship admin email failed for order ${orderId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );

    return updated;
  }

  /**
   * Tells the admin a self-ship seller submitted (or updated) a tracking
   * link. Same recipient chain as every other admin email — Admin Alert
   * Email from platform settings first (see
   * MailService.resolveAdminRecipient).
   */
  private async emailAdminSelfShipTracking(
    orderId: string,
    seller: { id: string; companyName: string },
    trackingUrl: string,
    courierName: string | undefined,
    isFirstSubmit: boolean,
  ): Promise<void> {
    const to = await this.mailService.resolveAdminRecipient();
    if (!to) {
      this.logger.warn(
        `self-ship-tracking admin email skipped: no Admin Alert Email in settings and neither ADMIN_NOTIFICATION_EMAIL nor SMTP_USER is set (order ${orderId}, seller ${seller.id})`,
      );
      return;
    }

    const orderRef = orderId.slice(0, 8).toUpperCase();
    const safeCompany = this.escape(seller.companyName);
    const safeUrl = this.escape(trackingUrl);
    const courierLine = courierName ? `\nCourier: ${courierName}` : '';
    const safeCourier = courierName
      ? `<br/>Courier: <strong>${this.escape(courierName)}</strong>`
      : '';
    const verb = isFirstSubmit ? 'submitted' : 'updated';

    const result = await this.mailService.sendMail({
      to,
      subject: `Self-ship tracking ${verb} for order ${orderRef}`,
      text: `${seller.companyName} has ${verb} a self-ship tracking link for order ${orderRef}.${courierLine}\nTracking: ${trackingUrl}`,
      html: `<p><strong>${safeCompany}</strong> has ${verb} a self-ship tracking link for order <strong>${orderRef}</strong>.${safeCourier}</p><p>Tracking: <a href="${safeUrl}">${safeUrl}</a></p>`,
    });
    if (!result.sent) {
      this.logger.warn(
        `Could not email admin about self-ship tracking for order ${orderId} (retryable=${result.retryable})`,
      );
    }
  }

  // ──────────────────────────────────────────────
  // UPDATE ADMIN SHIPPING DOCS (Admin)
  // ──────────────────────────────────────────────
  async updateAdminShippingDocs(
    orderId: string,
    dto: {
      adminShippingLabelUrl?: string;
      adminInvoiceUrl?: string;
      manifestUrl?: string;
      invoiceUrl?: string;
      isShippingLocked?: boolean;
      sellerId?: string;
    },
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // Self-ship orders have no Shiprocket label/manifest/invoice to manage -
    // the seller ships with their own courier and documents.
    if (order.fulfillmentMode === FULFILLMENT_MODE_SELF_SHIP) {
      throw new ForbiddenException(
        'This order uses self-ship fulfillment — shipping documents do not apply.',
      );
    }

    const { sellerId, ...updateFields } = dto;

    // Only a real document upload should notify a seller - a lock-only
    // toggle (isShippingLocked with nothing else) leaves nothing to
    // download, so it must not trigger a "documents ready" email.
    const hasNewDocs = ADMIN_SHIPPING_DOC_FIELDS.some(
      (field) => updateFields[field],
    );

    // Which sellers actually had their OrderItem rows written - so the
    // "documents ready" email below only reaches sellers whose own order
    // view will actually show the new documents, not every seller on the
    // order regardless of whether their items were touched.
    let notifySellerIds: string[];

    if (sellerId) {
      // Update only order items for this seller
      await this.prisma.orderItem.updateMany({
        where: { orderId, sellerId },
        data: updateFields as any,
      });
      notifySellerIds = [sellerId];

      // Also update the parent order table if this is the only seller or as fallback
      const uniqueSellers = Array.from(new Set(order.items.map(i => i.sellerId)));
      if (uniqueSellers.length === 1 || uniqueSellers[0] === sellerId) {
        await this.prisma.order.update({
          where: { id: orderId },
          data: updateFields,
        });
      }
    } else {
      // Check if any seller has provided package details (or if it's only lock status changes)
      const anyPackageProvided = order.items.some(item => item.packageLength != null) || order.packageLength != null;
      if (!anyPackageProvided && Object.keys(updateFields).some(k => k !== 'isShippingLocked')) {
        throw new BadRequestException('Seller has not provided package details yet');
      }

      await this.prisma.order.update({
        where: { id: orderId },
        data: updateFields,
      });

      // Update the corresponding order items so they reflect the admin documents
      const itemsWithPackage = order.items.filter(item => item.packageLength != null);
      if (itemsWithPackage.length > 0) {
        const sellerIds = Array.from(new Set(itemsWithPackage.map(item => item.sellerId)));
        await this.prisma.orderItem.updateMany({
          where: { orderId, sellerId: { in: sellerIds } },
          data: updateFields as any,
        });
        notifySellerIds = sellerIds;
      } else {
        await this.prisma.orderItem.updateMany({
          where: { orderId },
          data: updateFields as any,
        });
        notifySellerIds = Array.from(new Set(order.items.map((item) => item.sellerId)));
      }
    }

    this.logger.log(`Order ${orderId} admin shipping docs updated`);

    if (hasNewDocs) {
      await this.sellerOrderNotifier.notifySellersDocsReady(
        notifySellerIds.map((id) => ({ orderId, sellerId: id })),
      );
    }

    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { include: { seller: true } } }
    });
  }

  /**
   * Best-effort — the shipping-details save has already succeeded by the
   * time this runs, so a mail failure here must never fail it.
   */
  private async emailAdminShippingDetailsSubmitted(
    orderId: string,
    seller: { id: string; companyName: string },
  ): Promise<void> {
    // Admin Alert Email (platform settings) wins, then ADMIN_NOTIFICATION_EMAIL,
    // then the platform's own inbox — see MailService.resolveAdminRecipient.
    const to = await this.mailService.resolveAdminRecipient();
    if (!to) {
      this.logger.warn(
        `shipping-details-submitted admin email skipped: no Admin Alert Email in settings and neither ADMIN_NOTIFICATION_EMAIL nor SMTP_USER is set (order ${orderId}, seller ${seller.id})`,
      );
      return;
    }

    const orderRef = orderId.slice(0, 8).toUpperCase();
    const safeCompanyName = this.escape(seller.companyName);
    const result = await this.mailService.sendMail({
      to,
      subject: `Shipping details submitted for order ${orderRef}`,
      text: `${seller.companyName} has submitted shipping details for order ${orderRef}.\n\nReview it in the admin dashboard.`,
      html: `<p><strong>${safeCompanyName}</strong> has submitted shipping details for order <strong>${orderRef}</strong>.</p><p>Review it in the admin dashboard.</p>`,
    });
    if (!result.sent) {
      this.logger.warn(
        `Could not email admin about shipping-details submission for order ${orderId} (retryable=${result.retryable})`,
      );
    }
  }

  /**
   * Escapes text for safe interpolation into an HTML email body. Same
   * approach as InvoiceEmailService.escape() / SellerOrderNotifierService.escape().
   */
  /**
   * The order's courier link and courier name, for the buyer's status email.
   *
   * Returns null rather than throwing: a notification is a courtesy, and a
   * database hiccup here must not stop the buyer being told their order moved.
   */
  private async shipmentLinkFor(
    orderId: string,
  ): Promise<{ trackingUrl: string | null; courierName: string | null } | null> {
    try {
      return await this.prisma.order.findUnique({
        where: { id: orderId },
        select: { trackingUrl: true, courierName: true },
      });
    } catch (error: any) {
      this.logger.warn(
        `Could not read tracking details for order ${orderId}: ${error?.message}`,
      );
      return null;
    }
  }

  private escape(value: string): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ──────────────────────────────────────────────
  // CANCEL ORDER — Buyer or Admin or Seller
  // ──────────────────────────────────────────────

  /**
   * In-app, email and SMS, the same three channels every other status change
   * uses — but built here rather than through BUYER_STATUS_UPDATES because
   * this one carries a reason, and the others do not.
   */
  private async notifyBuyerOfCancellation(
    orderId: string,
    reason?: string,
  ): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, buyerId: true, buyer: { select: { email: true, phone: true } } },
    });
    if (!order) return;

    const shortId = order.id.slice(0, 8).toUpperCase();
    const why = reason?.trim() ? `\n\nReason: ${reason.trim()}` : '';

    try {
      await this.notificationsService.notifyOrderCancelled(
        order.buyerId,
        order.id,
        reason,
      );
    } catch (error: any) {
      this.logger.warn(
        `In-app cancellation notice failed for order ${orderId}: ${error?.message}`,
      );
    }

    if (order.buyer?.email) {
      await this.mailService.sendMail({
        to: order.buyer.email,
        subject: `Your Yukizi order #${shortId} has been cancelled`,
        text: [
          'Hi,',
          '',
          `Your order #${shortId} has been cancelled.${why}`,
          '',
          'Anything already paid for this order will be refunded to the original payment method.',
          '',
          'Need help? Email support@yukizi.com',
          '',
          '— Team Yukizi',
        ].join('\n'),
        html:
          `<p>Hi,</p><p>Your order <strong>#${shortId}</strong> has been cancelled.</p>` +
          (reason?.trim()
            ? `<p style="color:#475569">Reason: ${this.escape(reason.trim())}</p>`
            : '') +
          '<p style="color:#475569;font-size:12px">Anything already paid for this order will be refunded to the original payment method.</p>' +
          '<p style="color:#475569;font-size:12px">Need help? Email <a href="mailto:support@yukizi.com">support@yukizi.com</a></p>',
      });
    }

    if (order.buyer?.phone) {
      // Same DLT-approved shape as the other status messages: no URL, no
      // free text from an admin, so the template cannot be rejected.
      await this.otpSmsService.sendTransactional(
        order.buyer.phone,
        `Your Yukizi order #${shortId} has been cancelled. Check the Yukizi app for details.`,
      );
    }
  }

  async cancelOrder(
    userId: string,
    orderId: string,
    role: string,
    reason?: string,
  ) {
    // 1. Fetch order
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        items: {
          include: {
            sellerOffer: {
              include: {
                batches: {
                  where: { expiryDate: { gt: new Date() } },
                  orderBy: { expiryDate: 'asc' },
                },
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    // 2. Permission check
    if (role === Role.BUYER && order.buyerId !== userId) {
      throw new ForbiddenException(
        'You do not have permission to cancel this order',
      );
    }

    // 3. Status validation
    const uncancelable: OrderStatus[] = [
      OrderStatus.SHIPPED,
      OrderStatus.DELIVERED,
      OrderStatus.RETURNED,
      OrderStatus.CANCELLED,
    ];
    if (uncancelable.includes(order.orderStatus)) {
      throw new BadRequestException(
        `Cannot cancel order in ${order.orderStatus} status`,
      );
    }

    // An order with a confirmed payment - fully paid (SUCCESS) or genuinely
    // part-paid (PARTIAL, which per PaymentsService only happens once a real
    // payment has been verified, not "not paid yet") - can never self-cancel
    // through this endpoint, buyer or admin. This is a first-pass guard
    // against the checkout page's Razorpay "payment cancelled" auto-cancel
    // racing a payment that actually just succeeded (checkout.js's
    // ondismiss can fire on/around a successful handler callback) -
    // restocking and cancelling an order money was just collected for would
    // be far worse than the phantom-order bug that auto-cancel exists to
    // fix. Re-checked again below, inside the transaction, since a payment
    // can be confirmed by a fully separate transaction in the gap between
    // this read and that write. A paid order that genuinely needs
    // cancelling is a refund, not a self-service cancel.
    const paidStatuses: PaymentStatus[] = [
      PaymentStatus.SUCCESS,
      PaymentStatus.PARTIAL,
    ];
    if (paidStatuses.includes(order.paymentStatus)) {
      throw new BadRequestException(
        'This order has a confirmed payment and cannot be cancelled here. Contact support for a refund.',
      );
    }

    // 4. Update order and restore stock in a transaction
    const updated = await this.prisma.$transaction(async (tx) => {
      // 4a. Update status - guarded on paymentStatus again (see comment
      // above): if a payment was confirmed in the gap since the check
      // above, this write matches zero rows and the whole cancel aborts
      // before anything else in this transaction has run.
      const guardedUpdate = await tx.order.updateMany({
        where: { id: orderId, paymentStatus: { notIn: paidStatuses } },
        data: {
          orderStatus: OrderStatus.CANCELLED,
          // Written in the same guarded statement as the status, so an order
          // can never end up cancelled with no record of why.
          cancellationReason: reason?.trim() || null,
          cancelledAt: new Date(),
        },
      });
      if (guardedUpdate.count === 0) {
        throw new BadRequestException(
          'This order has a confirmed payment and cannot be cancelled here. Contact support for a refund.',
        );
      }
      const cancelled = await tx.order.findUniqueOrThrow({ where: { id: orderId } });

      // 4b. Restore stock (to the earliest expiry batch)
      for (const item of order.items) {
        if (item.sellerOffer.batches.length > 0) {
          await tx.productBatch.update({
            where: { id: item.sellerOffer.batches[0].id },
            data: { stock: { increment: item.quantity } },
          });

          // Check if there are waitlisted users to notify
          const offerWithVariant = await tx.sellerOffer.findUnique({
            where: { id: item.sellerOffer.id },
            include: { variant: true },
          });
          const catalogProductId = offerWithVariant?.variant?.catalogProductId;

          if (catalogProductId) {
            const waitlisted = await tx.productWaitlist.findMany({
              where: { catalogProductId, isNotified: false },
              include: { catalogProduct: true },
            });

            if (waitlisted.length > 0) {
              const notifications = waitlisted.map((w) => ({
                userId: w.userId,
                message: `The product ${w.catalogProduct.name} you were waiting for is now back in stock!`,
              }));

              await tx.notification.createMany({ data: notifications });

              await tx.productWaitlist.updateMany({
                where: { id: { in: waitlisted.map((w) => w.id) } },
                data: { isNotified: true },
              });
            }
          }
        }
      }

      return cancelled;
    });

    this.logger.log(`Order ${orderId} was cancelled by ${role} ${userId}`);

    // The buyer is told their order is gone, and why. Detached and swallowed:
    // the cancellation is already committed and stock already restored, so a
    // notification channel having a bad day must not turn a completed cancel
    // into an error for whoever pressed the button.
    void this.notifyBuyerOfCancellation(orderId, reason).catch((error) => {
      this.logger.warn(
        `Could not tell the buyer order ${orderId} was cancelled: ${(error as Error)?.message}`,
      );
    });

    return updated;
  }
}
