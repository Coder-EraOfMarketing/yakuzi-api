import { BadRequestException, Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReportRange, WebAnalyticsReportsService } from './web-analytics-reports.service';

/** Parses from/to (ISO dates); defaults to the last 30 days; caps at 366 days. */
function parseRange(from?: string, to?: string): ReportRange {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 30 * 24 * 3600_000);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) throw new BadRequestException('Invalid from/to date');
  if (end.getTime() - start.getTime() > 366 * 24 * 3600_000) throw new BadRequestException('Range too large (max 366 days)');
  // "to" is exclusive; a bare date like 2026-08-10 should include that whole day.
  if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) end.setUTCHours(23, 59, 59, 999);
  return { from: start, to: end };
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))].join('\n');
}

@Controller('admin/analytics')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class WebAnalyticsAdminController {
  constructor(private readonly reports: WebAnalyticsReportsService) {}

  @Get('overview')
  async overview(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.overview(parseRange(from, to)) };
  }

  @Get('acquisition')
  async acquisition(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.acquisition(parseRange(from, to)) };
  }

  @Get('acquisition/sources')
  async sources(@Query('from') from?: string, @Query('to') to?: string, @Query('category') category?: string) {
    return { message: 'ok', data: await this.reports.sourceTable(parseRange(from, to), category ?? null) };
  }

  @Get('ai')
  async ai(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.aiTraffic(parseRange(from, to)) };
  }

  @Get('campaigns')
  async campaigns(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.campaigns(parseRange(from, to)) };
  }

  @Get('pages')
  async pages(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.pages(parseRange(from, to)) };
  }

  @Get('products')
  async products(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.products(parseRange(from, to)) };
  }

  @Get('products/sources')
  async productSources(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.productSources(parseRange(from, to)) };
  }

  @Get('signups')
  async signups(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.signups(parseRange(from, to)) };
  }

  @Get('funnel')
  async funnel(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.funnel(parseRange(from, to)) };
  }

  @Get('geography')
  async geography(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.geography(parseRange(from, to)) };
  }

  @Get('devices')
  async devices(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.devices(parseRange(from, to)) };
  }

  @Get('retention')
  async retention(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.retention(parseRange(from, to)) };
  }

  @Get('realtime')
  async realtime() {
    return { message: 'ok', data: await this.reports.realtime() };
  }

  @Get('quality')
  async quality(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.quality(parseRange(from, to)) };
  }

  @Get('searches')
  async searches(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.searches(parseRange(from, to)) };
  }

  @Get('events')
  async events(@Query('from') from?: string, @Query('to') to?: string) {
    return { message: 'ok', data: await this.reports.eventCounts(parseRange(from, to)) };
  }

  @Get('health')
  async health() {
    return { message: 'ok', data: await this.reports.healthReport() };
  }

  @Get('users/:userId')
  async userJourney(@Param('userId') userId: string) {
    return { message: 'ok', data: await this.reports.userJourney(userId) };
  }

  @Get('export')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="analytics-export.csv"')
  async export(
    @Query('report') report?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<string> {
    const range = parseRange(from, to);
    switch (report) {
      case 'sources': return toCsv(await this.reports.sourceTable(range, null) as never);
      case 'campaigns': return toCsv(await this.reports.campaigns(range) as never);
      case 'pages': return toCsv(await this.reports.pages(range) as never);
      case 'products': return toCsv(await this.reports.products(range) as never);
      case 'searches': return toCsv(await this.reports.searches(range) as never);
      case 'events': return toCsv(await this.reports.eventCounts(range) as never);
      default:
        throw new BadRequestException('report must be one of: sources, campaigns, pages, products, searches, events');
    }
  }
}
