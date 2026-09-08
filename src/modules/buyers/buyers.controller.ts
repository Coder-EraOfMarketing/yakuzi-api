import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Query,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiBearerAuth,
} from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { BuyersService } from './buyers.service';
import { CreateBuyerProfileDto } from './dto/create-buyer-profile.dto';
import { UpdateBuyerProfileDto } from './dto/update-buyer-profile.dto';

@ApiTags('Buyers')
@ApiBearerAuth('JWT-auth')
@Controller('buyers')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
export class BuyersController {
  constructor(private readonly buyersService: BuyersService) {}

  @Post('profile')
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create buyer KYC profile (BUYER role)' })
  @ApiResponse({ status: 201, description: 'Buyer profile created' })
  @ApiResponse({ status: 403, description: 'Forbidden — not a buyer' })
  async createProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: CreateBuyerProfileDto,
  ) {
    const data = await this.buyersService.createProfile(userId, dto);
    return { message: 'Buyer profile created successfully', data };
  }

  @Get('profile')
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get buyer profile (BUYER role)' })
  @ApiResponse({ status: 200, description: 'Buyer profile returned' })
  async getProfile(@CurrentUser('id') userId: string) {
    const data = await this.buyersService.getProfile(userId);
    return { message: 'Buyer profile retrieved successfully', data };
  }

  @Patch('profile')
  @Roles(Role.BUYER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update buyer profile (BUYER role)' })
  @ApiResponse({ status: 200, description: 'Buyer profile updated' })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateBuyerProfileDto,
  ) {
    const data = await this.buyersService.updateProfile(userId, dto);
    return { message: 'Buyer profile updated successfully', data };
  }

  @Post('onboard')
  @Roles(Role.SELLER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Seller onboards a buyer (SELLER role)' })
  @ApiResponse({ status: 201, description: 'Buyer onboarded successfully' })
  @ApiResponse({
    status: 400,
    description: 'Invalid buyer data or IDFY verification failed',
  })
  @ApiResponse({ status: 403, description: 'Forbidden — not a seller' })
  async onboardBuyer(
    @CurrentUser('id') sellerId: string,
    @Body() dto: CreateBuyerProfileDto,
  ) {
    const data = await this.buyersService.onboardBuyer(sellerId, dto);
    return { message: 'Buyer onboarded successfully', data };
  }

  @Get('all')
  @Roles(Role.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Get all buyer profiles (ADMIN only)' })
  @ApiResponse({ status: 200, description: 'List of buyer profiles' })
  async getAllBuyers(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const data = await this.buyersService.getAllBuyers(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
    );
    return { message: 'Buyers retrieved successfully', data };
  }
}
