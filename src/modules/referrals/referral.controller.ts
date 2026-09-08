import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';

import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { ReferralService } from './referral.service';

@ApiTags('Admin - Referrals')
@ApiBearerAuth('JWT-auth')
@Controller('admin/referrals')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class ReferralController {
  constructor(private readonly referralService: ReferralService) {}

  @Post()
  @ApiOperation({ summary: 'Generate a new referral code' })
  async generate(@Body() dto: any) {
    return this.referralService.generateReferralCode(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List all referral codes' })
  async list(@Query() query: { dateFrom?: string; dateTo?: string }) {
    const data = await this.referralService.getAllReferralCodes(query);
    return { data };
  }

  @Patch(':id/active')
  @ApiOperation({ summary: 'Toggle referral code active status' })
  async toggleActive(
    @Param('id') id: string,
    @Body('isActive') isActive: boolean,
  ) {
    return this.referralService.toggleActive(id, isActive);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete a referral code' })
  async remove(@Param('id') id: string) {
    return this.referralService.deleteReferralCode(id);
  }
}
