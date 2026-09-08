import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Query,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  BadRequestException,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { AdminService } from './admin.service';
import { QueryUsersDto } from './dto/query-users.dto';
import { AdminQueryProductsDto } from './dto/query-products.dto';
import { AdminQueryOrdersDto } from './dto/query-orders.dto';
import { AdminQueryPaymentsDto } from './dto/query-payments.dto';
import { AdminQuerySettlementsDto } from './dto/query-settlements.dto';
import { AdminQueryTicketsDto } from './dto/query-tickets.dto';
import { AdminUpdateOrderStatusDto } from './dto/admin-update-order-status.dto';
import { AdminUpdateTicketStatusDto } from './dto/admin-update-ticket-status.dto';
import { AdminReplyTicketDto } from './dto/admin-reply-ticket.dto';
import { MarkPaidDto } from '../settlements/dto/mark-paid.dto';
import { UpdateGstPanStatusDto } from './dto/update-gst-pan-status.dto';
import { UpdateSelfShipDto } from './dto/update-self-ship.dto';
import { AddMarketingProductDto } from './dto/add-marketing-product.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { UploadedFile, UseInterceptors } from '@nestjs/common';
import { AdminQuerySuggestionsDto } from './dto/query-suggestions.dto';
import { AdminUpdateProductDto } from './dto/admin-update-product.dto';
import { AdminCreateProductDto } from './dto/admin-create-product.dto';
import { UpdateSuggestionDto } from './dto/update-suggestion.dto';
import { UpdateSellerProfileDto } from '../sellers/dto/update-seller-profile.dto';

@ApiTags('Admin')
@ApiBearerAuth('JWT-auth')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  // ═══════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════

  @Get('dashboard')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get enhanced admin dashboard metrics' })
  @ApiResponse({ status: 200, description: 'Dashboard metrics returned' })
  async getDashboard(@Query() query: { dateFrom?: string; dateTo?: string }) {
    const data = await this.adminService.getDashboard(query);
    return { message: 'Dashboard metrics retrieved', data };
  }

  // ═══════════════════════════════════════════════════
  // USER MANAGEMENT
  // ═══════════════════════════════════════════════════

  @Get('users')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List all users (paginated, filterable by role/status/search)',
  })
  @ApiResponse({ status: 200, description: 'Paginated users list returned' })
  async getAllUsers(@Query() query: QueryUsersDto) {
    const data = await this.adminService.getAllUsers(query);
    return { message: 'Users retrieved successfully', data };
  }

  @Get('users/pending')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get pending KYC approval users' })
  @ApiResponse({ status: 200, description: 'Pending users list returned' })
  async getPendingUsers() {
    const data = await this.adminService.getPendingUsers();
    return { message: 'Pending users retrieved successfully', data };
  }

  @Get('users/sellers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all sellers' })
  async getSellers(@Query() query: QueryUsersDto) {
    const data = await this.adminService.getAllUsers({ ...query, role: Role.SELLER });
    return { message: 'Sellers retrieved successfully', data };
  }

  @Get('users/buyers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all buyers' })
  async getBuyers(@Query() query: QueryUsersDto) {
    const data = await this.adminService.getAllUsers({ ...query, role: Role.BUYER });
    return { message: 'Buyers retrieved successfully', data };
  }

  @Get('users/:id')

  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get a single user by ID with full profile and counts',
  })
  @ApiResponse({ status: 200, description: 'User details returned' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async getUserById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.getUserById(id);
    return { message: 'User retrieved successfully', data };
  }

  @Patch('users/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Approve a user KYC' })
  @ApiResponse({ status: 200, description: 'User approved' })
  async approveUser(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.approveUser(id);
    return { message: 'User approved successfully', data };
  }

  @Delete('users/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Hard delete a user and all related data' })
  @ApiResponse({ status: 200, description: 'User deleted' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async deleteUser(@Param('id', ParseUUIDPipe) id: string) {
    await this.adminService.deleteUser(id);
    return { message: 'User deleted successfully' };
  }

  @Patch('users/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a user KYC' })
  @ApiResponse({ status: 200, description: 'User rejected' })
  async rejectUser(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.rejectUser(id);
    return { message: 'User rejected successfully', data };
  }

  @Patch('users/:id/block')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Block a user (sets status to BLOCKED)' })
  @ApiResponse({ status: 200, description: 'User blocked' })
  @ApiResponse({ status: 400, description: 'User is already blocked' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async blockUser(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.blockUser(id);
    return { message: 'User blocked successfully', data };
  }

  @Patch('users/:id/unblock')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Unblock a user (restores status to APPROVED)' })
  @ApiResponse({ status: 200, description: 'User unblocked' })
  @ApiResponse({ status: 400, description: 'User is not blocked' })
  @ApiResponse({ status: 404, description: 'User not found' })
  async unblockUser(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.unblockUser(id);
    return { message: 'User unblocked successfully', data };
  }

  // ═══════════════════════════════════════════════════
  // PRODUCT MANAGEMENT
  // ═══════════════════════════════════════════════════

  @Get('products')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'List all products (paginated, filterable by seller/category/active/search)',
  })
  @ApiResponse({ status: 200, description: 'Paginated products list returned' })
  async getAllProducts(@Query() query: AdminQueryProductsDto) {
    const data = await this.adminService.getAllProducts(query);
    return { message: 'Products retrieved successfully', data };
  }

  @Post('products')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: "Create a product listing on behalf of a selected seller" })
  @ApiResponse({ status: 201, description: 'Product created for the selected seller' })
  @ApiResponse({ status: 400, description: 'Invalid product fields' })
  @ApiResponse({ status: 403, description: 'Selected seller has no seller profile' })
  @ApiResponse({ status: 404, description: 'Category or sub-category not found' })
  async createProductForSeller(
    @CurrentUser('id') adminUserId: string,
    @Body() dto: AdminCreateProductDto,
  ) {
    const data = await this.adminService.adminCreateProductForSeller(adminUserId, dto);
    return { message: 'Product created successfully', data };
  }

  @Get('products/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a single product with full details' })
  @ApiResponse({ status: 200, description: 'Product details returned' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async getProductById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.getProductById(id);
    return { message: 'Product retrieved successfully', data };
  }

  @Patch('products/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a product (catalog fields + URL slug w/ auto-301)' })
  @ApiResponse({ status: 200, description: 'Product updated' })
  @ApiResponse({ status: 400, description: 'Invalid slug' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  @ApiResponse({ status: 409, description: 'Slug already in use' })
  async updateProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateProductDto,
  ) {
    const data = await this.adminService.adminUpdateProduct(id, dto);
    return { message: 'Product updated successfully', data };
  }

  @Patch('products/:id/disable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Disable a product (set isActive=false)' })
  @ApiResponse({ status: 200, description: 'Product disabled' })
  @ApiResponse({ status: 400, description: 'Product is already disabled' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async disableProduct(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.disableProduct(id);
    return { message: 'Product disabled successfully', data };
  }

  @Patch('products/:id/enable')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Enable a product (set isActive=true)' })
  @ApiResponse({ status: 200, description: 'Product enabled' })
  @ApiResponse({ status: 400, description: 'Product is already active' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async enableProduct(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.enableProduct(id);
    return { message: 'Product enabled successfully', data };
  }

  @Patch('products/:id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve a product (sets approvalStatus=APPROVED, isActive=true)',
  })
  @ApiResponse({ status: 200, description: 'Product approved' })
  @ApiResponse({ status: 400, description: 'Product is already approved' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async approveProduct(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.approveProduct(id);
    return { message: 'Product approved successfully', data };
  }

  @Patch('products/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Reject a product (sets approvalStatus=REJECTED, isActive=false)',
  })
  @ApiResponse({ status: 200, description: 'Product rejected' })
  @ApiResponse({ status: 400, description: 'Product is already rejected' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async rejectProduct(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: { reason?: string },
  ) {
    const data = await this.adminService.rejectProduct(id, body.reason);
    return { message: 'Product rejected successfully', data };
  }

  @Delete('products/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Soft-delete a product (sets deletedAt + isActive=false)',
  })
  @ApiResponse({ status: 200, description: 'Product soft-deleted' })
  @ApiResponse({ status: 400, description: 'Product is already deleted' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async softDeleteProduct(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.softDeleteProduct(id);
    return { message: 'Product deleted successfully', data };
  }

  // ═══════════════════════════════════════════════════
  // ORDER MANAGEMENT
  // ═══════════════════════════════════════════════════

  @Get('orders')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'List all orders (paginated, filterable by status/buyer/seller/date)',
  })
  @ApiResponse({ status: 200, description: 'Paginated orders list returned' })
  async getAllOrders(@Query() query: AdminQueryOrdersDto) {
    const data = await this.adminService.getAllOrders(query);
    return { message: 'Orders retrieved successfully', data };
  }

  @Get('orders/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get full order details with buyer, items, payments',
  })
  @ApiResponse({ status: 200, description: 'Order details returned' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async getOrderById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.getOrderById(id);
    return { message: 'Order retrieved successfully', data };
  }

  @Patch('orders/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Override order status (admin can set any status)' })
  @ApiResponse({ status: 200, description: 'Order status updated' })
  @ApiResponse({ status: 404, description: 'Order not found' })
  async updateOrderStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateOrderStatusDto,
  ) {
    const data = await this.adminService.adminUpdateOrderStatus(id, dto);
    return { message: 'Order status updated successfully', data };
  }

  @Get('orders/test-orders-count')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Count how many test/QA buyer orders a cancel-test-orders call would attempt right now',
  })
  @ApiResponse({ status: 200, description: 'Count returned' })
  async getTestOrdersCount() {
    const data = await this.adminService.countCancellableTestOrders();
    return { message: 'Test order count retrieved', data };
  }

  @Post('orders/cancel-test-orders')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Cancel every still-cancellable order placed by the internal test/QA buyer account(s), restoring stock',
  })
  @ApiResponse({ status: 200, description: 'Test orders cancelled' })
  async cancelTestOrders() {
    const data = await this.adminService.cancelAllTestOrders();
    return { message: 'Test orders cancelled', data };
  }

  // ═══════════════════════════════════════════════════
  // PAYMENT MANAGEMENT
  // ═══════════════════════════════════════════════════

  @Get('payments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'List all payments (paginated, filterable by verificationStatus/orderId)',
  })
  @ApiResponse({ status: 200, description: 'Paginated payments list returned' })
  async getAllPayments(@Query() query: AdminQueryPaymentsDto) {
    const data = await this.adminService.getAllPayments(query);
    return { message: 'Payments retrieved successfully', data };
  }

  @Patch('payments/:id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Confirm a payment (recalculates order payment status, creates settlements if applicable)',
  })
  @ApiResponse({ status: 200, description: 'Payment confirmed' })
  @ApiResponse({
    status: 400,
    description: 'Payment already confirmed or rejected',
  })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async confirmPayment(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.adminConfirmPayment(id);
    return { message: 'Payment confirmed successfully', data };
  }

  @Patch('payments/:id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reject a payment' })
  @ApiResponse({ status: 200, description: 'Payment rejected' })
  @ApiResponse({
    status: 400,
    description: 'Payment already rejected or confirmed',
  })
  @ApiResponse({ status: 404, description: 'Payment not found' })
  async rejectPayment(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.adminRejectPayment(id);
    return { message: 'Payment rejected successfully', data };
  }

  // ═══════════════════════════════════════════════════
  // SETTLEMENT MANAGEMENT
  // ═══════════════════════════════════════════════════

  @Get('settlements')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List all settlements (paginated, filterable by status/sellerId)',
  })
  @ApiResponse({
    status: 200,
    description: 'Paginated settlements list returned',
  })
  async getAllSettlements(@Query() query: AdminQuerySettlementsDto) {
    const data = await this.adminService.getAllSettlements(query);
    return { message: 'Settlements retrieved successfully', data };
  }

  @Get('settlements/summary')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get true gross/pending/settled totals across ALL matching settlements (not just one page)',
  })
  @ApiResponse({ status: 200, description: 'Settlement totals returned' })
  async getSettlementsSummary(@Query() query: AdminQuerySettlementsDto) {
    const data = await this.adminService.getSettlementsSummary(query);
    return { message: 'Settlement summary retrieved successfully', data };
  }

  @Post('settlements/sync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sync missing settlements for all delivered and paid orders',
  })
  async syncSettlements() {
    const data = await this.adminService.syncSettlements();
    return { message: 'Settlement sync completed', data };
  }

  @Patch('settlements/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Mark a settlement as paid with payout reference' })
  @ApiResponse({ status: 200, description: 'Settlement marked as paid' })
  @ApiResponse({ status: 400, description: 'Settlement is already paid' })
  @ApiResponse({ status: 404, description: 'Settlement not found' })
  async markSettlementPaid(
    @Param('id') id: string,
    @Body() dto: MarkPaidDto,
  ) {
    const data = await this.adminService.markSettlementPaid(
      id,
      dto.payoutReference,
      dto.paymentProofUrl,
    );
    return { message: 'Settlement marked as paid', data };
  }

  // ═══════════════════════════════════════════════════
  // TICKET MANAGEMENT
  // ═══════════════════════════════════════════════════

  @Get('tickets')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List all support tickets (paginated, filterable by status)',
  })
  @ApiResponse({ status: 200, description: 'Paginated tickets list returned' })
  async getAllTickets(@Query() query: AdminQueryTicketsDto) {
    const data = await this.adminService.getAllTickets(query);
    return { message: 'Tickets retrieved successfully', data };
  }

  @Get('tickets/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a ticket with all messages' })
  @ApiResponse({ status: 200, description: 'Ticket details returned' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async getTicketById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.getTicketById(id);
    return { message: 'Ticket retrieved successfully', data };
  }

  @Post('tickets/:id/reply')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Reply to a ticket (creates message + sets status to IN_PROGRESS)',
  })
  @ApiResponse({ status: 201, description: 'Reply sent' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async replyToTicket(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminReplyTicketDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.adminService.adminReplyTicket(user.id, id, dto);
    return { message: 'Reply sent successfully', data };
  }

  @Patch('tickets/:id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update ticket status (OPEN, IN_PROGRESS, RESOLVED, CLOSED)',
  })
  @ApiResponse({ status: 200, description: 'Ticket status updated' })
  @ApiResponse({ status: 404, description: 'Ticket not found' })
  async updateTicketStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminUpdateTicketStatusDto,
  ) {
    const data = await this.adminService.adminUpdateTicketStatus(id, dto);
    return { message: 'Ticket status updated successfully', data };
  }

  // ═══════════════════════════════════════════════════
  // NOTIFICATIONS
  // ═══════════════════════════════════════════════════

  @Post('notifications/broadcast')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Broadcast a notification to all, buyers, or sellers',
  })
  @ApiResponse({ status: 200, description: 'Notification sent successfully' })
  async broadcastNotification(
    @Body()
    dto: import('./dto/admin-broadcast-notification.dto').AdminBroadcastNotificationDto,
    @CurrentUser() user: any,
  ) {
    const data = await this.adminService.adminBroadcastNotification(
      user.id,
      dto,
    );
    return { message: 'Broadcast initiated successfully', data };
  }

  @Get('notifications/broadcasts')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get history of broadcasted notifications' })
  @ApiResponse({ status: 200, description: 'Broadcast history returned' })
  async getBroadcastHistory() {
    const data = await this.adminService.getBroadcastHistory();
    return { message: 'Broadcast history retrieved', data };
  }

  @Get('notifications/broadcasts/me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Get current admin's history of broadcasted notifications",
  })
  @ApiResponse({ status: 200, description: 'Own broadcast history returned' })
  async getMyBroadcastHistory(@CurrentUser('id') adminId: string) {
    const data = await this.adminService.getMyBroadcastHistory(adminId);
    return { message: 'Your broadcast history retrieved', data };
  }

  // ═══════════════════════════════════════════════════
  // ADMIN MANAGEMENT (Role-Based Access Control)
  // ═══════════════════════════════════════════════════

  @Get('admins')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all admins with permissions' })
  @ApiResponse({ status: 200, description: 'Admins list returned' })
  async getAdmins() {
    const data = await this.adminService.getAdmins();
    return { message: 'Admins retrieved successfully', data };
  }

  // Declared before `admins/:id` so Express does not treat "access-catalog"
  // as an admin id (the UUID pipe would reject it with a 400).
  @Get('admins/access-catalog')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Tab groups and access levels for the grant screen' })
  @ApiResponse({ status: 200, description: 'Access catalog returned' })
  getAccessCatalog() {
    return {
      message: 'Access catalog retrieved',
      data: this.adminService.getAccessCatalog(),
    };
  }

  @Get('admins/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get admin by ID' })
  @ApiResponse({ status: 200, description: 'Admin details returned' })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  async getAdminById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.getAdminById(id);
    return { message: 'Admin retrieved successfully', data };
  }

  @Post('admins')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new admin with role-based permissions' })
  @ApiResponse({ status: 201, description: 'Admin created successfully' })
  async createAdmin(
    @Body() dto: import('./dto/create-admin.dto').CreateAdminDto,
  ) {
    const data = await this.adminService.createAdmin(dto);
    return { message: 'Admin created successfully', data };
  }

  @Patch('admins/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update admin details and permissions' })
  @ApiResponse({ status: 200, description: 'Admin updated successfully' })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  async updateAdmin(
    @CurrentUser('id') actorUserId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: import('./dto/update-admin.dto').UpdateAdminDto,
  ) {
    const data = await this.adminService.updateAdmin(actorUserId, id, dto);
    return { message: 'Admin updated successfully', data };
  }

  @Delete('admins/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete an admin' })
  @ApiResponse({ status: 200, description: 'Admin deleted successfully' })
  @ApiResponse({ status: 404, description: 'Admin not found' })
  async deleteAdmin(
    @CurrentUser('id') actorUserId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.adminService.deleteAdmin(actorUserId, id);
    return { message: 'Admin deleted successfully', data };
  }

  // ═══════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════

  @Get('analytics/revenue')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get revenue chart metric' })
  async getRevenueChart(@Query('period') period: string) {
    const data = await this.adminService.getRevenueChart(period);
    return { message: 'Revenue chart retrieved', data };
  }

  @Get('analytics/orders')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get orders chart metric' })
  async getOrdersChart(@Query('period') period: string) {
    const data = await this.adminService.getOrdersChart(period);
    return { message: 'Orders chart retrieved', data };
  }

  @Get('analytics/top-products')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get top products' })
  async getTopProducts(@Query('limit') limit: number) {
    const data = await this.adminService.getTopProducts(limit);
    return { message: 'Top products retrieved', data };
  }

  @Get('analytics/top-sellers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get top sellers' })
  async getTopSellers(@Query('limit') limit: number) {
    const data = await this.adminService.getTopSellers(limit);
    return { message: 'Top sellers retrieved', data };
  }

  // ═══════════════════════════════════════════════════
  // GST/PAN VERIFICATION STATUS
  // ═══════════════════════════════════════════════════

  @Patch('buyers/:id/gst-pan-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update buyer GST/PAN verification status and credit tier',
  })
  @ApiResponse({ status: 200, description: 'Buyer GST/PAN status updated' })
  @ApiResponse({ status: 404, description: 'Buyer profile not found' })
  async updateBuyerGstPanStatus(
    @Param('id', ParseUUIDPipe) buyerId: string,
    @Body() dto: UpdateGstPanStatusDto,
  ) {
    const data = await this.adminService.updateBuyerGstPanStatus(buyerId, dto);
    return { message: 'Buyer GST/PAN status updated', data };
  }

  @Patch('sellers/:id/gst-pan-status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Update seller GST/PAN verification status and credit tier',
  })
  @ApiResponse({ status: 200, description: 'Seller GST/PAN status updated' })
  @ApiResponse({ status: 404, description: 'Seller profile not found' })
  async updateSellerGstPanStatus(
    @Param('id', ParseUUIDPipe) sellerId: string,
    @Body() dto: UpdateGstPanStatusDto,
  ) {
    const data = await this.adminService.updateSellerGstPanStatus(
      sellerId,
      dto,
    );
    return { message: 'Seller GST/PAN status updated', data };
  }

  @Patch('sellers/:id/self-ship')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Toggle a seller's self-ship fulfillment mode (affects new orders only)",
  })
  @ApiResponse({ status: 200, description: 'Seller self-ship flag updated' })
  @ApiResponse({ status: 404, description: 'Seller profile not found' })
  async updateSellerSelfShip(
    @Param('id', ParseUUIDPipe) sellerId: string,
    @Body() dto: UpdateSelfShipDto,
  ) {
    const data = await this.adminService.updateSellerSelfShip(sellerId, dto);
    return { message: 'Seller self-ship flag updated', data };
  }

  @Patch('users/:id/seller-profile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Admin: edit a seller's KYC/profile details (company, GST/PAN, address, bank account, etc)",
  })
  @ApiResponse({ status: 200, description: 'Seller profile updated' })
  @ApiResponse({ status: 404, description: 'Seller not found' })
  async updateSellerProfileAdmin(
    @Param('id', ParseUUIDPipe) userId: string,
    @Body() dto: UpdateSellerProfileDto,
  ) {
    const data = await this.adminService.updateSellerProfile(userId, dto);
    return { message: 'Seller profile updated successfully', data };
  }

  // ═══════════════════════════════════════════════════
  // SUGGESTIONS (MASTER PRODUCTS)
  // ═══════════════════════════════════════════════════

  @Get('suggestions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all master products (suggestions)' })
  @ApiResponse({ status: 200, description: 'Suggestions list returned' })
  async getSuggestions(@Query() query: AdminQuerySuggestionsDto) {
    const data = await this.adminService.getSuggestions(query);
    return { message: 'Suggestions retrieved', ...data };
  }

  @Post('suggestions')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new master product' })
  @ApiResponse({ status: 201, description: 'Suggestion created' })
  async createSuggestion(@Body() dto: UpdateSuggestionDto) {
    const data = await this.adminService.createSuggestion(dto);
    return { message: 'Suggestion created successfully', data };
  }

  @Post('suggestions/import')
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(FileInterceptor('file'))
  @ApiOperation({ summary: 'Import suggestions from CSV' })
  @ApiResponse({ status: 201, description: 'Import successful' })
  async importSuggestions(@UploadedFile() file: any) {
    if (!file) throw new BadRequestException('No CSV file uploaded');
    const data = await this.adminService.importSuggestions(file.buffer);
    return { message: 'Import completed successfully', ...data };
  }

  @Get('suggestions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get suggestion details' })
  @ApiResponse({ status: 200, description: 'Suggestion details returned' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async getSuggestionById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.getSuggestionById(id);
    return { message: 'Suggestion retrieved', data };
  }

  @Patch('suggestions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a suggestion' })
  @ApiResponse({ status: 200, description: 'Suggestion updated' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async updateSuggestion(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSuggestionDto,
  ) {
    const data = await this.adminService.updateSuggestion(id, dto);
    return { message: 'Suggestion updated successfully', data };
  }

  @Delete('suggestions/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a suggestion' })
  @ApiResponse({ status: 200, description: 'Suggestion soft-deleted' })
  @ApiResponse({ status: 404, description: 'Suggestion not found' })
  async deleteSuggestion(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.deleteSuggestion(id);
    return { message: 'Suggestion deleted successfully', data };
  }

  // ════════════════════════════════════════════════════════
  // MARKETING
  // ════════════════════════════════════════════════════════

  @Get('marketing')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List marketing products' })
  async getMarketingProducts(@Query('slot') slot?: string) {
    const data = await this.adminService.getMarketingProducts(slot);
    return { message: 'Marketing products retrieved', data };
  }

  @Post('marketing')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add product to marketing carousel' })
  async addMarketingProduct(@Body() dto: AddMarketingProductDto) {
    const data = await this.adminService.addMarketingProduct(dto);
    return { message: 'Product added to marketing successfully', data };
  }

  @Delete('marketing/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove product from marketing' })
  async removeMarketingProduct(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.adminService.removeMarketingProduct(id);
    return { message: 'Product removed from marketing successfully', data };
  }

  // ════════════════════════════════════════════════════════
  // PLATFORM SETTINGS
  // ════════════════════════════════════════════════════════

  @Get('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get platform settings' })
  async getSettings() {
    const data = await this.adminService.getPlatformSettings();
    return { message: 'Platform settings retrieved successfully', data };
  }

  @Patch('settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update platform settings' })
  async updateSettings(@Body() payload: Record<string, any>) {
    const data = await this.adminService.updatePlatformSettings(payload);
    return { message: 'Platform settings updated successfully', data };
  }
}

@ApiTags('Config')
@Controller('config/platform')
export class PublicConfigController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get public platform settings/config' })
  async getPublicConfig() {
    const data = await this.adminService.getPublicSettings();
    return { message: 'Platform config retrieved successfully', data };
  }
}

