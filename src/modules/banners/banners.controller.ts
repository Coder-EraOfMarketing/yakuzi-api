import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import {
  BannersService,
  CreateBannerDto,
  UpdateBannerDto,
} from './banners.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';
import { StorageService } from '../storage/storage.service';

@Controller('banners')
export class BannersController {
  constructor(private readonly bannersService: BannersService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async findAllPublic() {
    const data = await this.bannersService.findAll(false);
    return { message: 'Banners retrieved successfully', data };
  }
}

@Controller('admin/banners')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class AdminBannersController {
  constructor(
    private readonly bannersService: BannersService,
    private readonly storageService: StorageService,
  ) {}

  @Post()
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 1 },
      { name: 'mobileImage', maxCount: 1 },
    ]),
  )
  @HttpCode(HttpStatus.CREATED)
  async create(
    @UploadedFiles()
    files: { image?: Express.Multer.File[]; mobileImage?: Express.Multer.File[] },
    @Body() dto: CreateBannerDto,
  ) {
    const file = files?.image?.[0];
    if (!file) throw new BadRequestException('Image file is required');
    const imageUrl = await this.storageService.uploadBannerImage(file);
    const mobileFile = files?.mobileImage?.[0];
    const mobileImageUrl = mobileFile
      ? await this.storageService.uploadBannerImage(mobileFile)
      : undefined;
    const data = await this.bannersService.create({
      title: dto.title,
      link: dto.link,
      imageUrl,
      mobileImageUrl,
      order: dto.order ? Number(dto.order) : 0,
    });
    return { message: 'Banner created successfully', data };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async findAll() {
    const data = await this.bannersService.findAll(true);
    return { message: 'Banners retrieved successfully', data };
  }

  @Patch(':id')
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: 'image', maxCount: 1 },
      { name: 'mobileImage', maxCount: 1 },
    ]),
  )
  @HttpCode(HttpStatus.OK)
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFiles()
    files: { image?: Express.Multer.File[]; mobileImage?: Express.Multer.File[] },
    @Body() dto: UpdateBannerDto,
  ) {
    const file = files?.image?.[0];
    let imageUrl: string | undefined;
    if (file) {
      imageUrl = await this.storageService.uploadBannerImage(file);
    }
    // A new file replaces the mobile variant; removeMobileImage clears it;
    // neither leaves it untouched.
    const mobileFile = files?.mobileImage?.[0];
    let mobileImageUrl: string | null | undefined;
    if (mobileFile) {
      mobileImageUrl = await this.storageService.uploadBannerImage(mobileFile);
    } else if (String(dto.removeMobileImage) === 'true') {
      mobileImageUrl = null;
    }
    const data = await this.bannersService.update(id, {
      title: dto.title,
      link: dto.link,
      imageUrl,
      mobileImageUrl,
      isActive:
        dto.isActive !== undefined
          ? String(dto.isActive) === 'true'
          : undefined,
      order: dto.order ? Number(dto.order) : undefined,
    });
    return { message: 'Banner updated successfully', data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.bannersService.remove(id);
    return { message: 'Banner deleted successfully', data };
  }
}
