import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Delete,
  Param,
  Query,
  Body,
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
import { BlogService } from './blog.service';
import {
  CreateBlogPostDto,
  UpdateBlogPostDto,
  UpdateBlogStatusDto,
  QueryBlogDto,
  CreateBlogAuthorDto,
  UpdateBlogAuthorDto,
  CreateBlogCategoryDto,
  UpdateBlogCategoryDto,
} from './dto';

@ApiTags('Admin / Blog')
@ApiBearerAuth('JWT-auth')
@Controller('admin/blogs')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class BlogAdminController {
  constructor(private readonly blogService: BlogService) {}

  // ──────────────────────────────────────────────
  // BLOG POSTS
  // ──────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new blog post' })
  @ApiResponse({ status: 201, description: 'Blog post created' })
  async createPost(@Body() dto: CreateBlogPostDto) {
    const data = await this.blogService.createPost(dto);
    return { message: 'Blog post created successfully', data };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all blog posts (admin, with drafts)' })
  async getAllPosts(@Query() query: QueryBlogDto) {
    const data = await this.blogService.adminGetAllPosts(query);
    return { message: 'Blog posts retrieved successfully', data };
  }

  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a blog post by ID' })
  async getPostById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.blogService.adminGetPostById(id);
    return { message: 'Blog post retrieved successfully', data };
  }

  @Put(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a blog post' })
  async updatePost(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBlogPostDto,
  ) {
    const data = await this.blogService.updatePost(id, dto);
    return { message: 'Blog post updated successfully', data };
  }

  @Patch(':id/status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Publish or unpublish a blog post' })
  async updatePostStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBlogStatusDto,
  ) {
    const data = await this.blogService.updatePostStatus(id, dto);
    return { message: 'Blog post status updated successfully', data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a blog post' })
  async deletePost(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.blogService.deletePost(id);
    return { message: 'Blog post deleted successfully', data };
  }

  // ──────────────────────────────────────────────
  // AUTHORS
  // ──────────────────────────────────────────────

  @Post('authors')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a blog author' })
  async createAuthor(@Body() dto: CreateBlogAuthorDto) {
    const data = await this.blogService.createAuthor(dto);
    return { message: 'Author created successfully', data };
  }

  @Get('authors')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all blog authors' })
  async getAllAuthors() {
    const data = await this.blogService.getAllAuthors();
    return { message: 'Authors retrieved successfully', data };
  }

  @Get('authors/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get a blog author by ID' })
  async getAuthorById(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.blogService.getAuthorById(id);
    return { message: 'Author retrieved successfully', data };
  }

  @Put('authors/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a blog author' })
  async updateAuthor(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBlogAuthorDto,
  ) {
    const data = await this.blogService.updateAuthor(id, dto);
    return { message: 'Author updated successfully', data };
  }

  @Delete('authors/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a blog author' })
  async deleteAuthor(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.blogService.deleteAuthor(id);
    return { message: 'Author deleted successfully', data };
  }

  // ──────────────────────────────────────────────
  // CATEGORIES
  // ──────────────────────────────────────────────

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a blog category' })
  async createCategory(@Body() dto: CreateBlogCategoryDto) {
    const data = await this.blogService.createCategory(dto);
    return { message: 'Category created successfully', data };
  }

  @Get('categories')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all blog categories' })
  async getAllCategories() {
    const data = await this.blogService.getAllCategories();
    return { message: 'Categories retrieved successfully', data };
  }

  @Put('categories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a blog category' })
  async updateCategory(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBlogCategoryDto,
  ) {
    const data = await this.blogService.updateCategory(id, dto);
    return { message: 'Category updated successfully', data };
  }

  @Delete('categories/:id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Delete a blog category' })
  async deleteCategory(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.blogService.deleteCategory(id);
    return { message: 'Category deleted successfully', data };
  }
}
