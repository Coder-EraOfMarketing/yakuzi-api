import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  Req,
  Headers,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Throttle, SkipThrottle } from '@nestjs/throttler';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { RazorpayService } from './razorpay.service';
import { CreatePaymentDto } from './dto/create-payment.dto';
import { UploadProofDto } from './dto/upload-proof.dto';
import { CreateRazorpayOrderDto } from './dto/create-razorpay-order.dto';
import { VerifyRazorpayDto } from './dto/verify-razorpay.dto';

@ApiTags('Payments')
@ApiBearerAuth('JWT-auth')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly paymentsService: PaymentsService,
    private readonly razorpayService: RazorpayService,
  ) {}

  // ──────────────────────────────────────────────
  // BUYER: Record a payment attempt
  // ──────────────────────────────────────────────

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Record a manual payment (buyer)' })
  @ApiResponse({ status: 201, description: 'Payment recorded' })
  @ApiResponse({ status: 400, description: 'Invalid payment data' })
  async createPayment(
    @CurrentUser('id') userId: string,
    @Body() dto: CreatePaymentDto,
  ) {
    const data = await this.paymentsService.createPayment(userId, dto);
    return { message: 'Payment recorded', data };
  }

  // ──────────────────────────────────────────────
  // BUYER: Pay online with Razorpay
  // ──────────────────────────────────────────────

  @Post('razorpay/order')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Start an online payment for an order (buyer)' })
  @ApiResponse({ status: 201, description: 'Razorpay order created' })
  @ApiResponse({ status: 400, description: 'Order already paid or has no amount' })
  @ApiResponse({ status: 503, description: 'Razorpay keys are not configured' })
  async createRazorpayOrder(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateRazorpayOrderDto,
  ) {
    const data = await this.razorpayService.createOrder(userId, dto.orderId);
    return { message: 'Payment started', data };
  }

  @Post('razorpay/verify')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm an online payment against its signature (buyer)' })
  @ApiResponse({ status: 200, description: 'Payment verified and confirmed' })
  @ApiResponse({ status: 400, description: 'Signature did not verify' })
  async verifyRazorpayPayment(
    @CurrentUser('id') userId: string,
    @Body() dto: VerifyRazorpayDto,
  ) {
    const data = await this.razorpayService.verifyPayment(userId, dto);
    return { message: 'Payment verified', data };
  }

  // ──────────────────────────────────────────────
  // RAZORPAY: server-to-server webhook
  // ──────────────────────────────────────────────

  // No auth guard on purpose: Razorpay's servers call this, not a signed-in
  // user. Authentication is the HMAC over the raw body, checked in the
  // service. Throttling is skipped because Razorpay batches retries from its
  // own IPs and a dropped event is a lost payment confirmation.
  @Post('razorpay/webhook')
  @SkipThrottle()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Razorpay webhook (payment.captured); HMAC-authenticated' })
  @ApiResponse({ status: 200, description: 'Event acknowledged' })
  @ApiResponse({ status: 400, description: 'Signature did not verify' })
  @ApiResponse({ status: 503, description: 'Webhook secret is not configured' })
  async razorpayWebhook(
    @Req() req: { rawBody?: Buffer },
    @Headers('x-razorpay-signature') signature?: string,
  ) {
    return this.razorpayService.handleWebhook(req.rawBody, signature);
  }

  // ──────────────────────────────────────────────
  // BUYER: Upload payment proof
  // ──────────────────────────────────────────────

  @Post(':id/proof')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload payment proof screenshot/receipt' })
  @ApiResponse({ status: 200, description: 'Proof uploaded' })
  async uploadProof(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) paymentId: string,
    @Body() dto: UploadProofDto,
  ) {
    const data = await this.paymentsService.uploadProof(userId, paymentId, dto);
    return { message: 'Payment proof uploaded', data };
  }

  @Post('order/:orderId/proof')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Upload payment proof by order ID' })
  @ApiResponse({ status: 200, description: 'Proof uploaded' })
  async uploadProofByOrder(
    @CurrentUser('id') userId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: UploadProofDto,
  ) {
    const data = await this.paymentsService.uploadProofByOrder(
      userId,
      orderId,
      dto,
    );
    return { message: 'Payment proof uploaded', data };
  }

  // ──────────────────────────────────────────────
  // BUYER: Get all payments for an order
  // ──────────────────────────────────────────────

  @Get('order/:orderId')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get payment history for an order' })
  @ApiResponse({ status: 200, description: 'Payment history returned' })
  async getOrderPayments(
    @CurrentUser('id') userId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    const data = await this.paymentsService.getOrderPayments(userId, orderId);
    return { message: 'Payment history retrieved', data };
  }

  // ──────────────────────────────────────────────
  // ADMIN: Confirm a payment
  // ──────────────────────────────────────────────

  @Patch(':id/confirm')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Confirm a payment (admin)' })
  @ApiResponse({ status: 200, description: 'Payment confirmed' })
  async confirmPayment(@Param('id', ParseUUIDPipe) paymentId: string) {
    const data = await this.paymentsService.confirmPayment(paymentId);
    return { message: 'Payment confirmed', data };
  }

  // ──────────────────────────────────────────────
  // ADMIN: Reject a payment
  // ──────────────────────────────────────────────

  @Patch(':id/reject')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a payment (admin)' })
  @ApiResponse({ status: 200, description: 'Payment rejected' })
  async rejectPayment(@Param('id', ParseUUIDPipe) paymentId: string) {
    const data = await this.paymentsService.rejectPayment(paymentId);
    return { message: 'Payment rejected', data };
  }
}
