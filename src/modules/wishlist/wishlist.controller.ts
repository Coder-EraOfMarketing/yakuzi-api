import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { WishlistService } from './wishlist.service';
import { AddWishlistItemDto, MergeWishlistDto } from './dto/wishlist.dto';

/**
 * The paths here match what the storefront already calls — GET /wishlist,
 * POST /wishlist, DELETE /wishlist/:productId — which until now answered 404
 * on every request because no such routes existed.
 */
@ApiTags('Wishlist')
@ApiBearerAuth('JWT-auth')
@Controller('wishlist')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.BUYER)
export class WishlistController {
  constructor(private readonly wishlistService: WishlistService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "The buyer's saved items" })
  @ApiResponse({ status: 200, description: 'Wishlist returned' })
  async list(@CurrentUser('id') userId: string) {
    const data = await this.wishlistService.list(userId);
    return { message: 'Wishlist retrieved successfully', data };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Save an item. Saving it twice is a no-op.' })
  @ApiResponse({ status: 201, description: 'Item saved' })
  async add(
    @CurrentUser('id') userId: string,
    @Body() dto: AddWishlistItemDto,
  ) {
    const data = await this.wishlistService.add(userId, dto.productId.trim());
    return { message: 'Added to wishlist', data };
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Fold a browser's saved items into the account, on sign-in",
  })
  @ApiResponse({ status: 200, description: 'Merged' })
  async merge(
    @CurrentUser('id') userId: string,
    @Body() dto: MergeWishlistDto,
  ) {
    const data = await this.wishlistService.merge(userId, dto.productIds ?? []);
    return { message: 'Wishlist merged', data };
  }

  @Delete(':productId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Remove a saved item by product id. Removing what is not there succeeds.',
  })
  @ApiResponse({ status: 200, description: 'Removed' })
  async remove(
    @CurrentUser('id') userId: string,
    @Param('productId') productId: string,
  ) {
    const data = await this.wishlistService.remove(userId, productId);
    return { message: 'Removed from wishlist', data };
  }
}
