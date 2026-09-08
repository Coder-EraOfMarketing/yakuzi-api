import {
  Controller,
  Get,
  Post,
  Body,
  Patch,
  Param,
  Delete,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BlogService } from './blog.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role, BlogStatus } from '@prisma/client';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { OptionalJwtAuthGuard } from '../../common/guards/optional-jwt-auth.guard';

@ApiTags('Blog')
@Controller('blog')
export class BlogController {
  constructor(private readonly blogService: BlogService) {}

  @Post('posts')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a new blog post (Admin only)' })
  create(@Body() createPostDto: any, @CurrentUser('id') userId: string) {
    return this.blogService.createPost(createPostDto, userId);
  }

  @Get('posts')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get all public blog posts' })
  findAll(
    @Query('category') categoryId?: string,
    @Query('status') status?: BlogStatus,
    @CurrentUser() user?: { role?: Role },
  ) {
    const isAdmin = user?.role === Role.ADMIN;
    return this.blogService.findAllPosts({ categoryId, status }, isAdmin);
  }

  @Get('posts/:idOrSlug')
  @UseGuards(OptionalJwtAuthGuard)
  @ApiOperation({ summary: 'Get a blog post by ID or Slug' })
  findOne(
    @Param('idOrSlug') idOrSlug: string,
    @CurrentUser() user?: { role?: Role },
  ) {
    return this.blogService.findOnePost(idOrSlug, user?.role === Role.ADMIN);
  }

  @Patch('posts/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Update a blog post (Admin only)' })
  update(@Param('id') id: string, @Body() updatePostDto: any) {
    return this.blogService.updatePost(id, updatePostDto);
  }

  @Delete('posts/:id')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Delete a blog post (Admin only)' })
  remove(@Param('id') id: string) {
    return this.blogService.removePost(id);
  }

  @Get('categories')
  @ApiOperation({ summary: 'Get all blog categories' })
  findAllCategories() {
    return this.blogService.findAllCategories();
  }

  @Post('categories')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @ApiBearerAuth('JWT-auth')
  @ApiOperation({ summary: 'Create a blog category (Admin only)' })
  createCategory(@Body() createCategoryDto: any) {
    return this.blogService.createCategory(createCategoryDto);
  }

  @Get('authors')
  @ApiOperation({ summary: 'Get all blog authors' })
  findAllAuthors() {
    return this.blogService.findAllAuthors();
  }
}
