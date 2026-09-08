import {
  Controller,
  Post,
  Get,
  Patch,
  Put,
  Delete,
  Param,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
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
import { CategoriesService } from './categories.service';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import { CreateSubCategoryDto } from './dto/create-subcategory.dto';
import { UpdateSubCategoryDto } from './dto/update-subcategory.dto';
import {
  BulkCreateCategoryDto,
  BulkCreateSubCategoryDto,
} from './dto/bulk-category.dto';
import { QuerySubCategoryDto } from './dto/query-subcategory.dto';
import { ReplaceBannersDto } from './dto/replace-banners.dto';

@ApiTags('Admin - Categories')
@ApiBearerAuth('JWT-auth')
@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class CategoriesController {
  constructor(private readonly categoriesService: CategoriesService) {}

  // ═══════════════════════════════════════════════════
  // CATEGORIES
  // ═══════════════════════════════════════════════════

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a category (admin only)' })
  @ApiResponse({ status: 201, description: 'Category created' })
  @ApiResponse({ status: 409, description: 'Category already exists' })
  async createCategory(@Body() dto: CreateCategoryDto) {
    const data = await this.categoriesService.createCategory(dto);
    return { message: 'Category created successfully', data };
  }

  @Get('categories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List all categories with subcategories (admin only)',
  })
  @ApiResponse({ status: 200, description: 'Categories returned' })
  async findAllCategories() {
    const data = await this.categoriesService.findAllCategories();
    return { message: 'Categories retrieved successfully', data };
  }

  @Get('categories/map')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get category name-to-ID map (for migration scripts)',
  })
  @ApiResponse({ status: 200, description: 'Category map returned' })
  async getCategoryMap() {
    const data = await this.categoriesService.getCategoryMap();
    return { message: 'Category map retrieved successfully', data };
  }

  @Patch('categories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a category (admin only)' })
  @ApiResponse({ status: 200, description: 'Category updated' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  @ApiResponse({ status: 409, description: 'Category name already exists' })
  async updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCategoryDto,
  ) {
    const data = await this.categoriesService.updateCategory(id, dto);
    return { message: 'Category updated successfully', data };
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a category (admin only)' })
  @ApiResponse({ status: 200, description: 'Category deleted' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async deleteCategory(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.categoriesService.deleteCategory(id);
    return data;
  }

  @Post('categories/bulk')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Bulk create categories (for migration/seeding)' })
  @ApiResponse({ status: 201, description: 'Bulk creation result' })
  async bulkCreateCategories(@Body() dto: BulkCreateCategoryDto) {
    const data = await this.categoriesService.bulkCreateCategories(dto);
    return { message: 'Bulk category creation completed', data };
  }

  @Put('categories/:id/banners')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replace a category's banner slideshow (admin only)",
  })
  @ApiResponse({ status: 200, description: 'Banners replaced' })
  @ApiResponse({ status: 404, description: 'Category not found' })
  async replaceCategoryBanners(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceBannersDto,
  ) {
    const data = await this.categoriesService.replaceCategoryBanners(id, dto);
    return { message: 'Category banners updated successfully', data };
  }

  // ═══════════════════════════════════════════════════
  // SUBCATEGORIES
  // ═══════════════════════════════════════════════════

  @Post('subcategories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a subcategory (admin only)' })
  @ApiResponse({ status: 201, description: 'SubCategory created' })
  @ApiResponse({
    status: 409,
    description: 'SubCategory already exists under category',
  })
  async createSubCategory(@Body() dto: CreateSubCategoryDto) {
    const data = await this.categoriesService.createSubCategory(dto);
    return { message: 'SubCategory created successfully', data };
  }

  @Get('subcategories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'List subcategories (optionally filter by categoryId)',
  })
  @ApiResponse({ status: 200, description: 'SubCategories returned' })
  async findAllSubCategories(@Query() query: QuerySubCategoryDto) {
    const data = await this.categoriesService.findAllSubCategories(query);
    return { message: 'SubCategories retrieved successfully', data };
  }

  @Get('subcategories/map')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get subcategory name-to-ID map (for migration scripts)',
  })
  @ApiResponse({ status: 200, description: 'SubCategory map returned' })
  async getSubCategoryMap() {
    const data = await this.categoriesService.getSubCategoryMap();
    return { message: 'SubCategory map retrieved successfully', data };
  }

  @Patch('subcategories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a subcategory (admin only)' })
  @ApiResponse({ status: 200, description: 'SubCategory updated' })
  @ApiResponse({ status: 404, description: 'SubCategory not found' })
  async updateSubCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSubCategoryDto,
  ) {
    const data = await this.categoriesService.updateSubCategory(id, dto);
    return { message: 'SubCategory updated successfully', data };
  }

  @Delete('subcategories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a subcategory (admin only)' })
  @ApiResponse({ status: 200, description: 'SubCategory deleted' })
  @ApiResponse({ status: 404, description: 'SubCategory not found' })
  async deleteSubCategory(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.categoriesService.deleteSubCategory(id);
    return data;
  }

  @Post('subcategories/bulk')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Bulk create subcategories (for migration/seeding)',
  })
  @ApiResponse({ status: 201, description: 'Bulk creation result' })
  async bulkCreateSubCategories(@Body() dto: BulkCreateSubCategoryDto) {
    const data = await this.categoriesService.bulkCreateSubCategories(dto);
    return { message: 'Bulk subcategory creation completed', data };
  }

  @Put('subcategories/:id/banners')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Replace a sub-category's banner slideshow (admin only)",
  })
  @ApiResponse({ status: 200, description: 'Banners replaced' })
  @ApiResponse({ status: 404, description: 'SubCategory not found' })
  async replaceSubCategoryBanners(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReplaceBannersDto,
  ) {
    const data = await this.categoriesService.replaceSubCategoryBanners(
      id,
      dto,
    );
    return { message: 'SubCategory banners updated successfully', data };
  }
}
