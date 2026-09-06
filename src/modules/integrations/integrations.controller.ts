import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IntegrationProvider, Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { IntegrationsService } from './integrations.service';
import { IntegrationOAuthService } from './integration-oauth.service';
import { IntegrationImportService } from './integration-import.service';
import { IntegrationOrdersService } from './integration-orders.service';
import {
  CheckWooCommerceStoreDto,
  CompleteSetupDto,
  MapProductDto,
  QueryMappingCandidatesDto,
  QueryMappingsDto,
  ResolveInventoryConflictDto,
  StartAmazonConnectionDto,
  StartShopifyConnectionDto,
  StartWooCommerceConnectionDto,
  UpdateIntegrationSettingsDto,
} from './dto';

/**
 * Seller-facing integrations API.
 *
 * Every route is guarded and every service call resolves the seller from the
 * JWT — no endpoint accepts a sellerId, so one seller cannot reach another's
 * connections by changing an id in the URL.
 */
@ApiTags('Integrations')
@ApiBearerAuth('JWT-auth')
@Controller('integrations')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SELLER)
export class IntegrationsController {
  constructor(
    private readonly integrationsService: IntegrationsService,
    private readonly oauthService: IntegrationOAuthService,
    private readonly importService: IntegrationImportService,
    private readonly ordersService: IntegrationOrdersService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Connection status for every supported channel, plus sync totals',
  })
  @ApiResponse({ status: 200, description: 'Integration overview returned' })
  async list(@CurrentUser('id') userId: string) {
    const data = await this.integrationsService.listForSeller(userId);
    return { message: 'Integrations retrieved successfully', data };
  }

  @Get('amazon/marketplaces')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Amazon marketplaces, with a suggested default' })
  async amazonMarketplaces(@CurrentUser('id') userId: string) {
    const data = await this.oauthService.getAmazonMarketplaces(userId);
    return { message: 'Marketplaces retrieved successfully', data };
  }

  @Get(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Detail for one connected channel' })
  @ApiResponse({ status: 404, description: 'Not connected' })
  async getOne(
    @CurrentUser('id') userId: string,
    @Param('provider') provider: string,
  ) {
    const data = await this.integrationsService.getByProvider(
      userId,
      this.parseProvider(provider),
    );
    return { message: 'Integration retrieved successfully', data };
  }

  // ── Connect ───────────────────────────────────────────────────────────────
  // Rate-limited: each one issues state and, for WooCommerce, makes an
  // outbound request to a seller-supplied host.

  @Post('shopify/connect')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Begin Shopify authorization' })
  async connectShopify(
    @CurrentUser('id') userId: string,
    @Body() dto: StartShopifyConnectionDto,
  ) {
    const data = await this.oauthService.startShopify(userId, dto.shopDomain);
    return { message: 'Authorization URL created', data };
  }

  @Post('woocommerce/check')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Check a WooCommerce store before authorizing' })
  async checkWooCommerce(
    @CurrentUser('id') userId: string,
    @Body() dto: CheckWooCommerceStoreDto,
  ) {
    const data = await this.oauthService.checkWooCommerceStore(
      userId,
      dto.storeUrl,
    );
    return { message: 'Store checked', data };
  }

  @Post('woocommerce/connect')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Begin WooCommerce authorization' })
  async connectWooCommerce(
    @CurrentUser('id') userId: string,
    @Body() dto: StartWooCommerceConnectionDto,
  ) {
    const data = await this.oauthService.startWooCommerce(userId, dto.storeUrl);
    return { message: 'Authorization URL created', data };
  }

  @Post('amazon/connect')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @ApiOperation({ summary: 'Begin Amazon SP-API authorization' })
  async connectAmazon(
    @CurrentUser('id') userId: string,
    @Body() dto: StartAmazonConnectionDto,
  ) {
    const data = await this.oauthService.startAmazon(userId, dto.marketplaceId);
    return { message: 'Authorization URL created', data };
  }

  // ── Manage ────────────────────────────────────────────────────────────────

  @Patch(':id/settings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update synchronization settings' })
  async updateSettings(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateIntegrationSettingsDto,
  ) {
    const data = await this.integrationsService.updateSettings(userId, id, dto);
    return { message: 'Settings updated successfully', data };
  }

  @Post(':id/setup')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete the post-connection setup wizard' })
  async completeSetup(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CompleteSetupDto,
  ) {
    const data = await this.integrationsService.completeSetup(userId, id, dto);
    return { message: 'Setup completed successfully', data };
  }

  @Post(':id/sync')
  @HttpCode(HttpStatus.ACCEPTED)
  @Throttle({ default: { limit: 6, ttl: 60000 } })
  @ApiOperation({
    summary: 'Queue a sync. Returns the existing job if one is already running',
  })
  async requestSync(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.integrationsService.requestSync(userId, id);
    return { message: 'Sync queued', data };
  }

  @Get(':id/activity')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recent synchronization activity' })
  async activity(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryMappingsDto,
  ) {
    const sellerId = await this.integrationsService.resolveSellerId(userId);
    // listActivity is seller-scoped, so an id from another seller returns
    // nothing rather than someone else's history.
    const data = await this.integrationsService.listActivity(
      sellerId,
      id,
      query.page ?? 1,
      query.limit ?? 20,
    );
    return { message: 'Activity retrieved successfully', data };
  }

  @Get(':id/mappings')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Product mapping status for a channel' })
  async mappings(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: QueryMappingsDto,
  ) {
    const data = await this.integrationsService.listMappings(userId, id, query);
    return { message: 'Mappings retrieved successfully', data };
  }

  @Patch(':id/mappings/:mappingId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Manually map an external listing to a Yukizi product' })
  async mapProduct(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @Body() dto: MapProductDto,
  ) {
    const data = await this.integrationsService.mapProduct(
      userId,
      id,
      mappingId,
      dto.sellerOfferId,
    );
    return { message: 'Product mapped successfully', data };
  }

  @Get('orders/external')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Orders placed on connected channels. Never Yukizi orders, and never counted in settlements',
  })
  async externalOrders(
    @CurrentUser('id') userId: string,
    @Query() query: QueryMappingsDto,
  ) {
    const data = await this.ordersService.listOrders(userId, {
      page: query.page,
      limit: query.limit,
    });
    return { message: 'Channel orders retrieved successfully', data };
  }

  @Get('mappings/candidates')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Seller's own listings, for manual mapping" })
  async mappingCandidates(
    @CurrentUser('id') userId: string,
    @Query() query: QueryMappingCandidatesDto,
  ) {
    const data = await this.integrationsService.listMappingCandidates(
      userId,
      query.search,
    );
    return { message: 'Candidates retrieved successfully', data };
  }

  @Post(':id/mappings/:mappingId/resolve-inventory')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resolve one inventory difference in favour of Yukizi or the channel',
  })
  async resolveInventoryConflict(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('mappingId', ParseUUIDPipe) mappingId: string,
    @Body() dto: ResolveInventoryConflictDto,
  ) {
    const data = await this.importService.resolveInventoryConflict(
      userId,
      id,
      mappingId,
      dto.choice,
    );
    return { message: 'Inventory difference resolved', data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Disconnect a channel. Yukizi products are never deleted',
  })
  async disconnect(
    @CurrentUser('id') userId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.integrationsService.disconnect(userId, id);
    return { message: 'Integration disconnected successfully', data };
  }

  /** Maps the URL slug to the enum, rejecting anything unsupported. */
  private parseProvider(value: string): IntegrationProvider {
    const normalized = (value || '').toUpperCase();
    if (
      normalized === IntegrationProvider.SHOPIFY ||
      normalized === IntegrationProvider.WOOCOMMERCE ||
      normalized === IntegrationProvider.AMAZON
    ) {
      return normalized as IntegrationProvider;
    }
    // Reuse the not-found shape: an unknown provider has no integration.
    throw new NotFoundException('Integration not found');
  }
}
