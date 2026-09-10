import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  NotFoundException,
  UnprocessableEntityException,
  ServiceUnavailableException,
  Logger,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OrdersService } from './orders.service';
import { ShiprocketService } from './shiprocket.service';
import { SelfShipTrackingDto } from './dto/self-ship-tracking.dto';
import { InvoiceService } from './invoice.service';
import { InvoiceEmailService } from './invoice-email.service';
import { InvoicePdfService } from './invoice-pdf.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { UpdateOrderStatusDto } from './dto/update-order-status.dto';
import { UpdateShippingDetailsDto } from './dto/update-shipping-details.dto';
import { CancelOrderDto } from './dto/cancel-order.dto';

@ApiTags('Orders')
@ApiBearerAuth('JWT-auth')
@Controller('orders')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
export class OrdersController {
  private readonly logger = new Logger(OrdersController.name);

  constructor(
    private readonly ordersService: OrdersService,
    private readonly shiprocketService: ShiprocketService,
    private readonly invoiceService: InvoiceService,
    private readonly invoiceEmailService: InvoiceEmailService,
    private readonly invoicePdfService: InvoicePdfService,
  ) {}

  // ──────────────────────────────────────────────
  // BUYER ENDPOINTS
  // ──────────────────────────────────────────────

  @Post()
  @Roles(Role.BUYER)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Checkout — create order from cart' })
  @ApiResponse({ status: 201, description: 'Order placed' })
  @ApiResponse({
    status: 400,
    description: 'Cart is empty or validation error',
  })
  async checkout(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateOrderDto,
  ) {
    const data = await this.ordersService.checkout(userId, dto);
    return { message: 'Order placed successfully', data };
  }

  @Get()
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List buyer orders' })
  @ApiResponse({ status: 200, description: 'Buyer orders returned' })
  async getBuyerOrders(@CurrentUser('id') userId: string) {
    const data = await this.ordersService.getBuyerOrders(userId);
    return { message: 'Orders retrieved successfully', data };
  }

  @Get('seller')
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List orders for current seller' })
  @ApiResponse({ status: 200, description: 'Seller orders returned' })
  async getSellerOrders(
    @CurrentUser('id') userId: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    const data = await this.ordersService.getSellerOrders(
      userId,
      dateFrom,
      dateTo,
    );
    return { message: 'Seller orders retrieved successfully', data };
  }

  @Get(':id')
  @Roles(Role.BUYER, Role.SELLER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get full order detail' })
  @ApiResponse({ status: 200, description: 'Order details returned' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrderDetail(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    const data = await this.ordersService.getOrderDetail(userId, orderId);
    return { message: 'Order details retrieved successfully', data };
  }

  @Get(':id/invoices')
  @Roles(Role.BUYER, Role.SELLER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Tax invoices for an order, one per seller, generated on the seller behalf',
  })
  @ApiResponse({ status: 200, description: 'Invoices returned' })
  @ApiResponse({ status: 403, description: 'Order belongs to another account' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrderInvoices(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    const data = await this.invoiceService.getInvoicesForOrder(userId, orderId);
    return { message: 'Invoices retrieved successfully', data };
  }

  @Get(':id/invoices/:sellerId/pdf')
  @Roles(Role.BUYER, Role.SELLER, Role.ADMIN)
  @ApiOperation({
    summary: "One seller's tax invoice for an order, as a PDF download",
  })
  @ApiResponse({ status: 200, description: 'PDF returned' })
  @ApiResponse({ status: 403, description: 'Order belongs to another account' })
  @ApiResponse({
    status: 404,
    description: 'Order not found, or that seller supplied nothing on it',
  })
  async downloadOrderInvoicePdf(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Param('sellerId', ParseUUIDPipe) sellerId: string,
    @Res() res: Response,
  ): Promise<void> {
    // The same guarded read the JSON endpoint uses, for the same reason: it
    // throws for someone else's order, and for a SELLER it returns only the
    // invoices they supplied — so a seller cannot pull a co-seller's invoice
    // off an order they happen to share. Admins get any of them.
    const invoices = await this.invoiceService.getInvoicesForOrder(
      userId,
      orderId,
    );
    const invoice = invoices.find((i) => i.sellerId === sellerId);
    if (!invoice) {
      throw new NotFoundException(
        'There is no invoice for that seller on this order.',
      );
    }

    const pdf = await this.invoicePdfService.render(invoice);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${this.invoicePdfService.filename(invoice)}"`,
    );
    res.setHeader('Content-Length', String(pdf.length));
    // A tax invoice names the buyer and their address: never let a shared
    // cache keep a copy.
    res.setHeader('Cache-Control', 'private, no-store');
    res.send(pdf);
  }

  // SELLER intentionally excluded: resendForOrder always emails the order's
  // BUYER — opening this to sellers would let a seller trigger an email to
  // a buyer they don't control, with no server-side check that they have
  // any legitimate reason to.
  @Post(':id/invoice/email')
  @Roles(Role.BUYER, Role.ADMIN)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Email the buyer the tax invoices for an order' })
  @ApiResponse({ status: 200, description: 'Invoice email sent' })
  @ApiResponse({ status: 403, description: 'Order belongs to another account' })
  @ApiResponse({
    status: 404,
    description: 'Order not found, or nothing to invoice',
  })
  @ApiResponse({ status: 422, description: 'No email address on the account' })
  @ApiResponse({
    status: 503,
    description: 'The invoice could not be sent right now',
  })
  async emailOrderInvoices(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    // Reuse the guarded read purely for its ownership check: it throws
    // ForbiddenException for anyone else's order and NotFoundException for one
    // that does not exist. Duplicating that logic here would risk it drifting.
    await this.invoiceService.getInvoicesForOrder(userId, orderId);

    const outcome = await this.invoiceEmailService.resendForOrder(orderId);

    if (outcome.sent) {
      return {
        message: 'Invoice emailed successfully',
        data: { sent: true },
      };
    }

    switch (outcome.reason) {
      case 'no-recipient':
        throw new UnprocessableEntityException(
          'Add an email address to your account to receive invoices.',
        );
      case 'nothing-to-send':
        throw new NotFoundException(
          'There is nothing to invoice on this order.',
        );
      case 'not-configured':
      case 'send-failed':
      default:
        // The distinction (SMTP unconfigured vs. a send that genuinely failed
        // after retries) is a server-side detail — the client only needs to
        // know it can try again.
        this.logger.error(
          `invoice email resend for order ${orderId} did not send: ${outcome.reason ?? 'unknown'}`,
        );
        throw new ServiceUnavailableException(
          'We could not email your invoice just now. Please try again shortly.',
        );
    }
  }

  @Patch(':id/cancel')
  @Roles(Role.BUYER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel order & restore stock' })
  @ApiResponse({ status: 200, description: 'Order cancelled' })
  async cancelOrder(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: CancelOrderDto,
  ) {
    const data = await this.ordersService.cancelOrder(
      userId,
      orderId,
      role,
      dto?.reason,
    );
    return { message: 'Order cancelled successfully', data };
  }

  // ──────────────────────────────────────────────
  // SELLER ENDPOINTS
  // ──────────────────────────────────────────────

  @Patch(':id/status')
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update order status (seller)' })
  @ApiResponse({ status: 200, description: 'Order status updated' })
  async updateOrderStatus(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateOrderStatusDto,
  ) {
    const data = await this.ordersService.updateOrderStatus(
      userId,
      orderId,
      dto,
    );
    return { message: 'Order status updated successfully', data };
  }

  @Patch(':id/shipping-details')
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update shipping dimensions and documents (seller)',
  })
  @ApiResponse({ status: 200, description: 'Shipping details updated' })
  async updateShippingDetails(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: UpdateShippingDetailsDto,
  ) {
    const data = await this.ordersService.updateShippingDetails(
      userId,
      orderId,
      dto,
    );
    return { message: 'Shipping details updated successfully', data };
  }

  // ──────────────────────────────────────────────
  // SELF-SHIP TRACKING (Seller)
  // ──────────────────────────────────────────────
  @Patch(':id/self-ship-tracking')
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Submit or edit the courier tracking link for a self-ship order (seller)',
  })
  @ApiResponse({ status: 200, description: 'Self-ship tracking saved' })
  async submitSelfShipTracking(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body() dto: SelfShipTrackingDto,
  ) {
    const data = await this.ordersService.submitSelfShipTracking(
      userId,
      orderId,
      dto,
    );
    return { message: 'Self-ship tracking saved successfully', data };
  }
  // ──────────────────────────────────────────────
  // ADMIN UPDATE SHIPPING DOCS
  // ──────────────────────────────────────────────
  @Patch(':id/admin-shipping-docs')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload shipping documents by admin' })
  @ApiResponse({ status: 200, description: 'Documents uploaded' })
  async updateAdminShippingDocs(
    @Param('id', ParseUUIDPipe) orderId: string,
    @Body()
    dto: {
      adminShippingLabelUrl?: string;
      adminInvoiceUrl?: string;
      manifestUrl?: string;
      invoiceUrl?: string;
      isShippingLocked?: boolean;
      sellerId?: string;
    },
  ) {
    const data = await this.ordersService.updateAdminShippingDocs(orderId, dto);
    return { message: 'Documents uploaded successfully', data };
  }

  // ──────────────────────────────────────────────
  // TRACKING ENDPOINT
  // ──────────────────────────────────────────────

  @Get(':id/tracking')
  @Roles(Role.BUYER, Role.SELLER, Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get order tracking timeline from Shiprocket' })
  @ApiResponse({ status: 200, description: 'Tracking info returned' })
  async getOrderTracking(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) orderId: string,
  ) {
    // Basic check to ensure order exists and user has access
    const order = await this.ordersService.getOrderDetail(userId, orderId);

    if (!order.shiprocketOrderId) {
      return {
        message: 'Tracking not available yet (not pushed to Shiprocket)',
        data: null,
      };
    }

    const data = await this.shiprocketService.trackOrder(
      order.shiprocketOrderId,
    );
    await this.ordersService.syncTrackingFields(orderId, {
      awb_code: data.awb_code,
      courier: data.courier,
      track_url: data.track_url as string | null,
    });
    return { message: 'Tracking details retrieved successfully', data };
  }
}
