import { Controller, Get, Post, Query, HttpCode, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { InstagramService } from './instagram.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@ApiTags('Instagram')
@Controller('instagram')
export class InstagramController {
  constructor(private readonly instagram: InstagramService) {}

  /**
   * Public: the storefront's homepage rail.
   *
   * Returns posts only — never the token that fetched them.
   */
  @Get('feed')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Recent Instagram posts for the storefront' })
  async feed(@Query('limit') limit?: string) {
    const parsed = Number(limit);
    const data = await this.instagram.getFeed(Number.isFinite(parsed) ? parsed : 8);
    return { message: 'Instagram feed retrieved successfully', data };
  }
}

@ApiTags('Instagram')
@Controller('admin/instagram')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class AdminInstagramController {
  constructor(private readonly instagram: InstagramService) {}

  /** Whether the saved token still works, and whose account it points at. */
  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Instagram connection status' })
  async status() {
    const data = await this.instagram.status();
    return { message: 'Instagram status retrieved successfully', data };
  }

  /** Buys another 60 days without a trip through Meta's dashboard. */
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Extend the saved long-lived token by 60 days' })
  async refresh() {
    const data = await this.instagram.refreshToken();
    return { message: 'Instagram token refresh attempted', data };
  }
}
