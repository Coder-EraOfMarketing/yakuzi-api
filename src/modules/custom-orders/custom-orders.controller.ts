import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  Param,
  Patch,
  Delete,
} from '@nestjs/common';
import { CustomOrdersService } from './custom-orders.service';
import { CreateCustomOrderDto } from './dto/create-custom-order.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Role } from '@prisma/client';

@Controller('custom-orders')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
export class CustomOrdersController {
  constructor(private readonly customOrdersService: CustomOrdersService) {}

  @Post()
  @Roles(Role.BUYER)
  async create(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateCustomOrderDto,
  ) {
    const data = await this.customOrdersService.create(userId, dto);
    return { message: 'Custom order request created', data };
  }

  @Get('admin')
  @Roles(Role.ADMIN)
  async findAll(@Query('page') page?: string, @Query('limit') limit?: string) {
    const data = await this.customOrdersService.findAll(
      Number(page ?? 1),
      Number(limit ?? 20),
    );
    return { message: 'Custom orders retrieved', data };
  }

  @Patch(':id/status')
  @Roles(Role.ADMIN)
  async updateStatus(@Param('id') id: string, @Body('status') status: string) {
    const data = await this.customOrdersService.updateStatus(id, status);
    return { message: 'Status updated', data };
  }

  @Delete(':id')
  @Roles(Role.ADMIN)
  async delete(@Param('id') id: string) {
    const data = await this.customOrdersService.delete(id);
    return { message: 'Custom order deleted', data };
  }
}
