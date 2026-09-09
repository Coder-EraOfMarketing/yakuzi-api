import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { KeywordType, SeoEntityType, SeoNotFoundStatus } from '@prisma/client';

/**
 * One FAQ row. A real class, not an inline `{ question, answer }` type.
 *
 * The global pipe runs with `transform: true` and `enableImplicitConversion`,
 * and a property whose only reflected type is `Array` has that same type
 * applied to its ELEMENTS. Every entry was therefore constructed as an Array
 * and, having no numeric keys, arrived as `[]`: four typed questions reached
 * the database as `[[], [], [], []]`. The text was destroyed inside the pipe,
 * before the service or Prisma ever saw it, so nothing rendered on the
 * storefront, no FAQPage JSON-LD was emitted, and the AI-visibility score
 * never counted an FAQ. `@Type` is what stops the elements being coerced.
 */
export class SeoFaqEntryDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  question!: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  answer!: string;
}

export class UpsertSeoMetaDto {
  @IsEnum(SeoEntityType)
  entityType!: SeoEntityType;

  /** Entity id, or the path for STATIC_PAGE / HOMEPAGE / LANDING_PAGE (e.g. "/about"). */
  @IsString()
  @IsNotEmpty()
  entityId!: string;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  description?: string;

  @IsOptional()
  @IsString()
  canonicalUrl?: string;

  @IsOptional()
  @IsString()
  @MaxLength(95)
  ogTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  ogDescription?: string;

  @IsOptional()
  @IsString()
  ogImageUrl?: string;

  @IsOptional()
  @IsIn(['summary', 'summary_large_image'])
  twitterCard?: string;

  /** e.g. "noindex,follow" — rendered verbatim into the robots meta tag. */
  @IsOptional()
  @IsString()
  robots?: string;

  @IsOptional()
  @IsString()
  focusKeyword?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  secondaryKeywords?: string[];

  @IsOptional()
  @IsString()
  entityDescription?: string;

  @IsOptional()
  @IsString()
  aiSummary?: string;

  /** [{question, answer}] — rendered as visible FAQ + FAQPage JSON-LD. */
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SeoFaqEntryDto)
  faq?: SeoFaqEntryDto[];

  /** Merged over the generated JSON-LD by the frontend. */
  @IsOptional()
  structuredDataOverride?: Record<string, unknown>;

  @IsOptional()
  imageAltOverrides?: Record<string, string>;
}

export class ListSeoMetaQueryDto {
  @IsOptional()
  @IsEnum(SeoEntityType)
  type?: SeoEntityType;

  @IsOptional()
  @IsIn(['title', 'description', 'aiSummary'])
  missing?: 'title' | 'description' | 'aiSummary';

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number;
}

export class CreateRedirectDto {
  @IsString()
  @IsNotEmpty()
  fromPath!: string;

  @IsString()
  @IsNotEmpty()
  toPath!: string;

  @IsOptional()
  @Type(() => Number)
  @IsIn([301, 302, 308, 410])
  statusCode?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

export class UpdateRedirectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  fromPath?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  toPath?: string;

  @IsOptional()
  @Type(() => Number)
  @IsIn([301, 302, 308, 410])
  statusCode?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsString()
  note?: string;
}

export class CreateKeywordDto {
  @IsString()
  @IsNotEmpty()
  name!: string;

  @IsEnum(KeywordType)
  type!: KeywordType;

  @IsOptional()
  @IsString()
  canonicalName?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  synonyms?: string[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  seasonStart?: string;

  @IsOptional()
  @IsString()
  seasonEnd?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateKeywordDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @IsOptional()
  @IsEnum(KeywordType)
  type?: KeywordType;

  @IsOptional()
  @IsString()
  canonicalName?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  synonyms?: string[];

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  parentId?: string;

  @IsOptional()
  @IsString()
  seasonStart?: string;

  @IsOptional()
  @IsString()
  seasonEnd?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class LinkKeywordDto {
  @IsEnum(SeoEntityType)
  entityType!: SeoEntityType;

  @IsString()
  @IsNotEmpty()
  entityId!: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  weight?: number;
}

export class UpdateProductSlugDto {
  @IsString()
  @IsNotEmpty()
  slug!: string;

  /** 301 the old URL to the new one. Default true. */
  @IsOptional()
  @IsBoolean()
  createRedirect?: boolean;
}

// ── Redirect tool ──────────────────────────────────────────────

/** One row of a CSV/pasted import. */
export class BulkRedirectRowDto {
  @IsString()
  @IsNotEmpty()
  fromPath!: string;

  @IsString()
  @IsNotEmpty()
  toPath!: string;

  @IsOptional()
  @Type(() => Number)
  @IsIn([301, 302, 308, 410])
  statusCode?: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class BulkCreateRedirectsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => BulkRedirectRowDto)
  rows!: BulkRedirectRowDto[];
}

export class BulkRedirectIdsDto {
  @IsArray()
  @IsString({ each: true })
  ids!: string[];

  /** Only read by the activate/deactivate route. */
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Public: the storefront reporting that a rule fired. */
export class RecordRedirectHitDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  path!: string;
}

/** Public: the storefront reporting a 404. */
export class RecordNotFoundDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(2000)
  path!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  referrer?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  userAgent?: string;
}

export class UpdateNotFoundStatusDto {
  @IsEnum(SeoNotFoundStatus)
  status!: SeoNotFoundStatus;
}
