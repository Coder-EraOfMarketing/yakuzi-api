import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
} from '@nestjs/swagger';
import { MigrationEntityType } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { MigrationService } from './migration.service';
import { MigrateUsersDto } from './dto/migrate-users.dto';
import { MigrateOrdersDto } from './dto/migrate-orders.dto';
import { MigratePaymentsDto } from './dto/migrate-payments.dto';

@ApiTags('Migration')
@ApiBearerAuth('JWT-auth')
@Controller('migration')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class MigrationController {
  constructor(private readonly migrationService: MigrationService) {}

  // ─── VALIDATION (dry-run) ─────────────────────────────

  @Post('validate/users')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate legacy user data before import (dry-run)',
  })
  async validateUsers(@Body() dto: MigrateUsersDto) {
    const result = await this.migrationService.validateUsers(dto.users);
    return { message: 'User validation complete', data: result };
  }

  @Post('validate/orders')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate legacy order data before import (dry-run)',
  })
  async validateOrders(@Body() dto: MigrateOrdersDto) {
    const result = await this.migrationService.validateOrders(dto.orders);
    return { message: 'Order validation complete', data: result };
  }

  @Post('validate/payments')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Validate legacy payment data before import (dry-run)',
  })
  async validatePayments(@Body() dto: MigratePaymentsDto) {
    const result = await this.migrationService.validatePayments(dto.payments);
    return { message: 'Payment validation complete', data: result };
  }

  // ─── IMPORT PIPELINES ─────────────────────────────────

  @Post('import/users')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Step 1: Import legacy users (buyers + sellers)' })
  async importUsers(@Body() dto: MigrateUsersDto) {
    const result = await this.migrationService.migrateUsers(dto.users);
    return { message: 'User migration complete', data: result };
  }

  @Post('import/orders')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary:
      'Step 2: Import legacy orders (requires users + products imported first)',
  })
  async importOrders(@Body() dto: MigrateOrdersDto) {
    const result = await this.migrationService.migrateOrders(dto.orders);
    return { message: 'Order migration complete', data: result };
  }

  @Post('import/payments')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Step 3: Import legacy payments (requires orders imported first)',
  })
  async importPayments(@Body() dto: MigratePaymentsDto) {
    const result = await this.migrationService.migratePayments(dto.payments);
    return { message: 'Payment migration complete', data: result };
  }

  // ─── RECONCILIATION ───────────────────────────────────

  @Post('reconcile')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      'Post-migration reconciliation: compare legacy data against migrated data',
  })
  async reconcile(
    @Body()
    body: {
      users: MigrateUsersDto['users'];
      orders: MigrateOrdersDto['orders'];
      payments: MigratePaymentsDto['payments'];
    },
  ) {
    const result = await this.migrationService.reconcile(
      body.users,
      body.orders,
      body.payments,
    );
    return { message: 'Reconciliation complete', data: result };
  }

  // ─── STATUS & MONITORING ──────────────────────────────

  @Get('status')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get migration status overview' })
  async getStatus() {
    const data = await this.migrationService.getMigrationStatus();
    return { message: 'Migration status', data };
  }

  @Get('runs/:runId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get detailed info for a specific migration run' })
  async getRunDetails(@Param('runId', ParseUUIDPipe) runId: string) {
    const data = await this.migrationService.getRunDetails(runId);
    return { message: 'Run details', data };
  }

  @Get('failures')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all failed migration records' })
  @ApiQuery({ name: 'entityType', required: false, enum: MigrationEntityType })
  async getFailures(@Query('entityType') entityType?: MigrationEntityType) {
    const data = await this.migrationService.getFailedRecords(entityType);
    return { message: 'Failed records', data };
  }

  // ─── ROLLBACK ─────────────────────────────────────────

  @Delete('rollback/:runId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rollback a specific migration run (deletes imported data)',
  })
  async rollbackRun(@Param('runId', ParseUUIDPipe) runId: string) {
    const result = await this.migrationService.rollbackRun(runId);
    return { message: 'Rollback complete', data: result };
  }

  @Delete('rollback-all')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Rollback ALL migration data (requires confirm=true)',
  })
  @ApiQuery({ name: 'confirm', required: true, type: Boolean })
  async rollbackAll(@Query('confirm') confirm: string) {
    const result = await this.migrationService.rollbackAll(confirm === 'true');
    return { message: 'Full rollback complete', data: result };
  }
}
