import {
  IsDefined,
  IsString,
  IsOptional,
  IsArray,
  IsEnum,
  IsUUID,
  IsUrl,
  MaxLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { BlogStatus } from '@prisma/client';

export class CreateBlogPostDto {
  @ApiProperty({ example: 'Best Medicines for Cold in India' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiPropertyOptional({ example: 'best-medicines-for-cold-india' })
  @IsOptional()
  @IsString()
  @MaxLength(250)
  slug?: string;

  @ApiPropertyOptional({ example: 'Discover effective medicines for cold...' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  excerpt?: string;

  /**
   * The post body: the rich-text editor's HTML today, an Editor.js JSON
   * object historically, so the type stays `any`.
   *
   * @IsDefined is load-bearing, not decoration. main.ts runs the global pipe
   * with `whitelist: true, forbidNonWhitelisted: true`, which strips — and
   * then rejects — any property carrying no class-validator constraint.
   * @ApiProperty is a Swagger decorator and registers none, so every attempt
   * to create or update a post was answered with "property content should
   * not exist" and no post could be written through this API at all.
   */
  @ApiProperty({ description: 'Editor.js JSON or rich text content' })
  @IsDefined()
  content: any;

  @ApiPropertyOptional({ example: 'https://example.com/image.jpg' })
  @IsOptional()
  @IsString()
  featuredImage?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  images?: string[];

  @ApiProperty({ example: 'uuid-of-author' })
  @IsUUID()
  authorId: string;

  @ApiProperty({ example: 'uuid-of-category' })
  @IsUUID()
  categoryId: string;

  /**
   * Every credited author, byline order. The first becomes `authorId`, which
   * stays the primary — so a reader that knows nothing about co-authors still
   * gets a correct post. Omit to credit `authorId` alone.
   */
  @ApiPropertyOptional({ type: [String], example: ['uuid-a', 'uuid-b'] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  authorIds?: string[];

  /**
   * Every category the post is filed under. The first becomes `categoryId`,
   * which stays the one that owns the post's articleSection and its place in
   * the storefront's category listing.
   */
  @ApiPropertyOptional({ type: [String], example: ['uuid-a', 'uuid-b'] })
  @IsOptional()
  @IsArray()
  @IsUUID('4', { each: true })
  categoryIds?: string[];

  @ApiPropertyOptional({ example: ['cold', 'medicine', 'india'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ enum: BlogStatus, default: BlogStatus.DRAFT })
  @IsOptional()
  @IsEnum(BlogStatus)
  status?: BlogStatus;

  // SEO Fields
  @ApiPropertyOptional({ example: 'Best Cold Medicines in India | Yukizi' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  metaTitle?: string;

  @ApiPropertyOptional({ example: 'Top medicines for cold relief...' })
  @IsOptional()
  @IsString()
  @MaxLength(320)
  metaDescription?: string;

  @ApiPropertyOptional({ example: ['cold medicine india', 'flu tablets'] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  metaKeywords?: string[];

  @ApiPropertyOptional({ example: 'https://yukizi.com/blog/cold-medicine' })
  @IsOptional()
  @IsString()
  canonicalUrl?: string;

  @ApiPropertyOptional({ example: 'https://example.com/og-image.jpg' })
  @IsOptional()
  @IsString()
  ogImage?: string;
}
