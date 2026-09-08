import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
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
import { ProductsService } from './products.service';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { QueryProductDto } from './dto/query-product.dto';
import { CreateProductRequestDto } from './dto/create-product-request.dto';
import { BulkCreateProductDto } from './dto/bulk-create-product.dto';
import { AddToWaitlistDto } from './dto/add-to-waitlist.dto';

@ApiTags('Products')
@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  // ──────────────────────────────────────────────
  // PRODUCT REQUESTS (Must be above :id to avoid collisions)
  // ──────────────────────────────────────────────

  @Post('requests')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.SELLER, Role.BUYER)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Request a new product to be added to the platform',
  })
  @ApiResponse({ status: 201, description: 'Request created' })
  async createRequest(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProductRequestDto,
  ) {
    const data = await this.productsService.createRequest(userId, dto);
    return { message: 'Product request submitted successfully', data };
  }

  @Get('my-requests')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.SELLER, Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List own product requests' })
  @ApiResponse({ status: 200, description: 'Own product requests list' })
  async findMyRequests(
    @CurrentUser('id') userId: string,
    @Query()
    query: {
      page?: number;
      limit?: number;
      status?: string;
      search?: string;
      dateFrom?: string;
      dateTo?: string;
    },
  ) {
    const data = await this.productsService.findAllRequests({
      ...query,
      userId,
    });
    return { message: 'Your product requests retrieved successfully', data };
  }

  @Get('requests')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List all product requests (Admin only)' })
  @ApiResponse({ status: 200, description: 'Product requests list' })
  async findAllRequests(
    @Query()
    query: {
      page?: number;
      limit?: number;
      status?: string;
      search?: string;
      dateFrom?: string;
      dateTo?: string;
    },
  ) {
    const data = await this.productsService.findAllRequests(query);
    return { message: 'Product requests retrieved successfully', data };
  }

  @Patch('requests/:id/status')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update product request status (Admin only)' })
  @ApiResponse({ status: 200, description: 'Request status updated' })
  async updateRequestStatus(
    @Param('id') id: string,
    @Body('status') status: any,
  ) {
    const data = await this.productsService.updateRequestStatus(id, status);
    return { message: 'Product request status updated successfully', data };
  }

  // ──────────────────────────────────────────────
  // PUBLIC ENDPOINTS (No auth required)
  // ──────────────────────────────────────────────

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Browse products with filtering & pagination' })
  @ApiResponse({ status: 200, description: 'Paginated product list' })
  async findAll(@Query() query: QueryProductDto) {
    const data = await this.productsService.findAll(query);
    return { message: 'Products retrieved successfully', data };
  }

  @Post('validate-ids')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Validate product IDs are active, not deleted, and in stock — returns current price/mrp/stock for each' })
  @ApiResponse({ status: 200, description: 'Price/mrp/stock for each still-purchasable id' })
  async validateIds(@Body() dto: { ids: string[] }) {
    const data = await this.productsService.validateIds(dto.ids);
    return { message: 'IDs validated successfully', data };
  }

  @Get('categories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List all categories with sub-categories' })
  @ApiResponse({ status: 200, description: 'Category tree returned' })
  async getCategories() {
    const data = await this.productsService.getCategories();
    return { message: 'Categories retrieved successfully', data };
  }

  @Get('manufacturers')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'List real manufacturer names for the buyer Filters panel' })
  @ApiResponse({ status: 200, description: 'Manufacturer list returned' })
  async getManufacturers() {
    const data = await this.productsService.getManufacturers();
    return { message: 'Manufacturers retrieved successfully', data };
  }

  @Throttle({ default: { limit: 100, ttl: 60000 } })
  @Get('suggestions')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get product name suggestions for autocomplete (master vs local)',
  })
  @ApiResponse({ status: 200, description: 'Suggestions returned' })
  async getSuggestions(
    @Query('search') q: string, // Changed from 'q' to 'search' to match your logs
    @Query('type') type: 'product' | 'master' = 'product',
  ) {
    const data = await this.productsService.getSuggestions(q, type);
    return { message: 'Suggestions retrieved successfully', data };
  }

  @Get('featured')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get featured products for marketing carousels (homepage/login)',
  })
  @ApiResponse({ status: 200, description: 'Featured products list' })
  async getFeatured(
    @Query('slot') slot: 'HOMEPAGE_CAROUSEL' | 'LOGIN_CAROUSEL',
  ) {
    const data = await this.productsService.getFeatured(slot);
    return { message: 'Featured products retrieved successfully', data };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get single product by ID' })
  @ApiResponse({ status: 200, description: 'Product details returned' })
  @ApiResponse({ status: 404, description: 'Product not found' })
  async findOne(@Param('id') id: string) {
    const data = await this.productsService.findOne(id);
    return { message: 'Product retrieved successfully', data };
  }

  // ──────────────────────────────────────────────
  // SELLER ENDPOINTS (Auth + SELLER role required)
  // ──────────────────────────────────────────────

  @Post()
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a new product (seller only)' })
  @ApiResponse({ status: 201, description: 'Product created' })
  @ApiResponse({ status: 403, description: 'Forbidden — not a seller' })
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateProductDto,
  ) {
    const data = await this.productsService.create(userId, dto);
    return { message: 'Product created successfully', data };
  }

  @Post('bulk')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({
    summary: 'Bulk-create products (seller only, migration-friendly)',
  })
  @ApiResponse({ status: 201, description: 'Bulk creation results returned' })
  async bulkCreate(
    @CurrentUser('id') userId: string,
    @Body() dto: BulkCreateProductDto,
  ) {
    const data = await this.productsService.bulkCreate(userId, dto);
    return { message: 'Bulk product creation completed', data };
  }

  @Get('seller/own')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'List own products (seller only)' })
  @ApiResponse({ status: 200, description: 'Seller products returned' })
  async findOwn(
    @CurrentUser('id') userId: string,
    @Query() query: QueryProductDto,
  ) {
    const data = await this.productsService.findOwn(userId, query);
    return { message: 'Products retrieved successfully', data };
  }

  @Patch(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update own product (seller only)' })
  @ApiResponse({ status: 200, description: 'Product updated' })
  async update(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateProductDto,
  ) {
    const data = await this.productsService.update(userId, id, dto);
    return { message: 'Product updated successfully', data };
  }

  @Delete(':id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Soft-delete own product (seller only)' })
  @ApiResponse({ status: 200, description: 'Product deleted' })
  async remove(@CurrentUser('id') userId: string, @Param('id') id: string) {
    const data = await this.productsService.softDelete(userId, id);
    return data;
  }

  // WAITLIST FEATURE

  @Get('waitlist/me')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Get current user waitlist (Notify Me)' })
  @ApiResponse({ status: 200, description: 'Waitlist retrieved' })
  async getMyWaitlist(@CurrentUser('id') userId: string) {
    const data = await this.productsService.getMyWaitlist(userId);
    return { message: 'Waitlist retrieved successfully', data };
  }

  @Post(':id/notify-me')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.CREATED)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Add product to Notify Me waitlist' })
  @ApiResponse({ status: 201, description: 'Added to waitlist' })
  async addToWaitlist(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: AddToWaitlistDto,
  ) {
    const data = await this.productsService.addToWaitlist(userId, id, dto.email);
    return { message: 'Added to waitlist', data };
  }

  @Delete(':id/notify-me')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Remove product from Notify Me waitlist' })
  @ApiResponse({ status: 200, description: 'Removed from waitlist' })
  async removeFromWaitlist(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
  ) {
    const data = await this.productsService.removeFromWaitlist(userId, id);
    return { message: 'Removed from waitlist', data };
  }
}
