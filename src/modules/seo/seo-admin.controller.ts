import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { KeywordType, Role, SeoEntityType, SeoNotFoundStatus } from '@prisma/client';
import { ImageRenameService } from './image-rename.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { SeoService } from './seo.service';
import { SeoRedirectsService } from './seo-redirects.service';
import { SeoKeywordsService } from './seo-keywords.service';
import { SeoNotFoundService } from './seo-not-found.service';
import {
  CreateKeywordDto,
  CreateRedirectDto,
  LinkKeywordDto,
  ListSeoMetaQueryDto,
  UpdateKeywordDto,
  UpdateProductSlugDto,
  UpdateRedirectDto,
  UpsertSeoMetaDto,
  BulkCreateRedirectsDto,
  BulkRedirectIdsDto,
  UpdateNotFoundStatusDto,
} from './seo.dto';

function parseEntityType(value: string): SeoEntityType {
  if (!Object.values(SeoEntityType).includes(value as SeoEntityType)) {
    throw new BadRequestException(
      `type must be one of: ${Object.values(SeoEntityType).join(', ')}`,
    );
  }
  return value as SeoEntityType;
}

@Controller('admin/seo')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class AdminSeoController {
  constructor(
    private readonly seoService: SeoService,
    private readonly redirectsService: SeoRedirectsService,
    private readonly keywordsService: SeoKeywordsService,
    private readonly notFoundService: SeoNotFoundService,
    private readonly imageRenameService: ImageRenameService,
  ) {}

  // ── product URL slug ──────────────────────────────────────
  // Catalog-id keyed (the SEO tab's PRODUCT keyspace). Changes the REAL
  // public URL, with the same 301-redirect handling as the product form.

  @Get('product-slug/:id')
  @HttpCode(HttpStatus.OK)
  async getProductSlug(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.seoService.getProductSlug(id);
    return { message: 'Product slug retrieved successfully', data };
  }

  @Patch('product-slug/:id')
  @HttpCode(HttpStatus.OK)
  async updateProductSlug(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateProductSlugDto,
  ) {
    const data = await this.seoService.updateProductSlug(id, dto.slug, {
      createRedirect: dto.createRedirect,
    });
    return { message: 'Product slug updated successfully', data };
  }

  // ── metadata ──────────────────────────────────────────────

  @Get('meta')
  @HttpCode(HttpStatus.OK)
  async listMeta(@Query() query: ListSeoMetaQueryDto) {
    const data = await this.seoService.listMeta(query);
    return { message: 'SEO meta list retrieved successfully', data };
  }

  @Get('meta/one')
  @HttpCode(HttpStatus.OK)
  async getMeta(@Query('type') type: string, @Query('id') id: string) {
    if (!type || !id) throw new BadRequestException('type and id are required');
    const data = await this.seoService.getMeta(parseEntityType(type), id);
    return { message: 'SEO meta retrieved successfully', data };
  }

  @Put('meta')
  @HttpCode(HttpStatus.OK)
  async upsertMeta(
    @Body() dto: UpsertSeoMetaDto,
    @CurrentUser('id') userId: string,
  ) {
    const data = await this.seoService.upsertMeta(dto, userId);
    return { message: 'SEO meta saved successfully', data };
  }

  @Get('meta/:id/revisions')
  @HttpCode(HttpStatus.OK)
  async revisions(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.seoService.getRevisions(id);
    return { message: 'Revisions retrieved successfully', data };
  }

  @Post('meta/:id/revisions/:revisionId/restore')
  @HttpCode(HttpStatus.OK)
  async restore(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('revisionId', ParseUUIDPipe) revisionId: string,
    @CurrentUser('id') userId: string,
  ) {
    const data = await this.seoService.restoreRevision(id, revisionId, userId);
    return { message: 'Revision restored successfully', data };
  }

  // ── redirects ─────────────────────────────────────────────

  @Get('redirects')
  @HttpCode(HttpStatus.OK)
  async listRedirects(
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('isActive') isActive?: string,
    @Query('statusCode') statusCode?: string,
    @Query('sort') sort?: 'recent' | 'hits' | 'path',
  ) {
    const data = await this.redirectsService.list({
      search,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
      isActive: isActive === undefined ? undefined : isActive === 'true',
      statusCode: statusCode ? Number(statusCode) : undefined,
      sort,
    });
    return { message: 'Redirects retrieved successfully', data };
  }

  /** Every rule, unpaginated — the admin turns this into a CSV download. */
  @Get('redirects/export')
  @HttpCode(HttpStatus.OK)
  async exportRedirects() {
    const data = await this.redirectsService.exportAll();
    return { message: 'Redirects exported successfully', data };
  }

  /**
   * "What happens if I visit this URL?" Walks the chain the way the storefront
   * does and reports the outcome: no rule, a switched-off rule, a single hop,
   * a multi-hop chain, or a loop.
   */
  @Get('redirects/resolve')
  @HttpCode(HttpStatus.OK)
  async resolveRedirect(@Query('path') path: string) {
    const data = await this.redirectsService.resolve(path);
    return { message: 'Resolved successfully', data };
  }

  @Post('redirects')
  @HttpCode(HttpStatus.CREATED)
  async createRedirect(@Body() dto: CreateRedirectDto) {
    const data = await this.redirectsService.create(dto);
    // Fixing a URL should clear it from the 404 worklist without anyone
    // having to remember to tick it off.
    await this.notFoundService.markFixed([data.fromPath]);
    return { message: 'Redirect created successfully', data };
  }

  @Patch('redirects/:id')
  @HttpCode(HttpStatus.OK)
  async updateRedirect(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRedirectDto,
  ) {
    const data = await this.redirectsService.update(id, dto);
    return { message: 'Redirect updated successfully', data };
  }

  @Delete('redirects/:id')
  @HttpCode(HttpStatus.OK)
  async deleteRedirect(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.redirectsService.remove(id);
    return { message: 'Redirect deleted successfully', data };
  }

  /**
   * Import. Deliberately not transactional: a 300-row paste with two bad
   * lines applies the 298 good ones and reports the two, instead of rejecting
   * everything and leaving someone to find the typo.
   */
  @Post('redirects/bulk')
  @HttpCode(HttpStatus.OK)
  async bulkCreateRedirects(@Body() dto: BulkCreateRedirectsDto) {
    const data = await this.redirectsService.bulkCreate(dto.rows);
    // Anything now covered by a rule stops being an open 404.
    await this.notFoundService.markFixed(data.createdPaths);
    return { message: `Imported ${data.created} redirect(s)`, data };
  }

  @Post('redirects/bulk/active')
  @HttpCode(HttpStatus.OK)
  async bulkSetRedirectActive(@Body() dto: BulkRedirectIdsDto) {
    const data = await this.redirectsService.bulkSetActive(dto.ids, dto.isActive ?? true);
    return { message: 'Redirects updated successfully', data };
  }

  @Post('redirects/bulk/delete')
  @HttpCode(HttpStatus.OK)
  async bulkDeleteRedirects(@Body() dto: BulkRedirectIdsDto) {
    const data = await this.redirectsService.bulkRemove(dto.ids);
    return { message: 'Redirects deleted successfully', data };
  }

  // ── 404 log ───────────────────────────────────────────────

  @Get('not-found')
  @HttpCode(HttpStatus.OK)
  async listNotFound(
    @Query('status') status?: SeoNotFoundStatus,
    @Query('search') search?: string,
    @Query('sort') sort?: 'hits' | 'recent' | 'oldest',
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.notFoundService.list({
      status,
      search,
      sort,
      page: page ? Number(page) : undefined,
      limit: limit ? Number(limit) : undefined,
    });
    return { message: '404s retrieved successfully', data };
  }

  @Get('not-found/summary')
  @HttpCode(HttpStatus.OK)
  async notFoundSummary() {
    const data = await this.notFoundService.summary();
    return { message: '404 summary retrieved successfully', data };
  }

  @Patch('not-found/:id')
  @HttpCode(HttpStatus.OK)
  async updateNotFoundStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNotFoundStatusDto,
  ) {
    const data = await this.notFoundService.setStatus(id, dto.status);
    return { message: '404 updated successfully', data };
  }

  @Delete('not-found/:id')
  @HttpCode(HttpStatus.OK)
  async deleteNotFound(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.notFoundService.remove(id);
    return { message: '404 deleted successfully', data };
  }

  @Post('not-found/clear-resolved')
  @HttpCode(HttpStatus.OK)
  async clearResolvedNotFound() {
    const data = await this.notFoundService.clearResolved();
    return { message: `Cleared ${data.deleted} resolved 404(s)`, data };
  }

  // ── keywords ──────────────────────────────────────────────

  @Get('keywords')
  @HttpCode(HttpStatus.OK)
  async listKeywords(
    @Query('type') type?: string,
    @Query('search') search?: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    const data = await this.keywordsService.list({
      type:
        type && Object.values(KeywordType).includes(type as KeywordType)
          ? (type as KeywordType)
          : undefined,
      search,
      includeInactive: includeInactive === 'true',
    });
    return { message: 'Keywords retrieved successfully', data };
  }

  @Post('keywords')
  @HttpCode(HttpStatus.CREATED)
  async createKeyword(@Body() dto: CreateKeywordDto) {
    const data = await this.keywordsService.create(dto);
    return { message: 'Keyword created successfully', data };
  }

  @Patch('keywords/:id')
  @HttpCode(HttpStatus.OK)
  async updateKeyword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateKeywordDto,
  ) {
    const data = await this.keywordsService.update(id, dto);
    return { message: 'Keyword updated successfully', data };
  }

  @Delete('keywords/:id')
  @HttpCode(HttpStatus.OK)
  async deleteKeyword(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.keywordsService.remove(id);
    return { message: 'Keyword deleted successfully', data };
  }

  @Get('keywords/:id/links')
  @HttpCode(HttpStatus.OK)
  async keywordLinks(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.keywordsService.links(id);
    return { message: 'Keyword links retrieved successfully', data };
  }

  @Post('keywords/:id/links')
  @HttpCode(HttpStatus.CREATED)
  async linkKeyword(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkKeywordDto,
  ) {
    const data = await this.keywordsService.link(id, dto);
    return { message: 'Keyword linked successfully', data };
  }

  @Delete('keywords/:id/links')
  @HttpCode(HttpStatus.OK)
  async unlinkKeyword(
    @Param('id', ParseUUIDPipe) id: string,
    @Query('type') type: string,
    @Query('entityId') entityId: string,
  ) {
    if (!type || !entityId) {
      throw new BadRequestException('type and entityId are required');
    }
    const data = await this.keywordsService.unlink(
      id,
      parseEntityType(type),
      entityId,
    );
    return { message: 'Keyword unlinked successfully', data };
  }

  // One-click batched SEO rename of EXISTING product images (copy-not-move;
  // old URLs stay alive). Re-runnable: already-renamed files are skipped via
  // the "-yukizi-" marker. The admin UI loops until remaining === 0.
  // Manual single-image rename (per-image control in the product SEO card).
  @Post('rename-product-image')
  @HttpCode(HttpStatus.OK)
  async renameProductImage(
    @Body('catalogProductId') catalogProductId: string,
    @Body('imageUrl') imageUrl: string,
    @Body('newName') newName: string,
  ) {
    if (!catalogProductId || !imageUrl || !newName?.trim()) {
      throw new BadRequestException('catalogProductId, imageUrl and newName are required');
    }
    const data = await this.imageRenameService.renameSingleImage(
      catalogProductId,
      imageUrl,
      newName,
    );
    if (!data.newUrl) throw new BadRequestException(data.reason ?? 'rename failed');
    return { message: 'Image renamed', data };
  }

  @Post('rename-product-images')
  @HttpCode(HttpStatus.OK)
  async renameProductImages(@Body('limit') limit?: number) {
    const capped = Math.min(Math.max(Number(limit) || 20, 1), 50);
    const data = await this.imageRenameService.renameProductImages(capped);
    return { message: 'Image rename batch complete', data };
  }
}
