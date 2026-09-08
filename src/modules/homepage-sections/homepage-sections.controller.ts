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
} from '@nestjs/common';
import {
  HomepageSectionsService,
  CreateHomepageSectionDto,
  UpdateHomepageSectionDto,
  ReorderHomepageSectionsDto,
} from './homepage-sections.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { Role } from '@prisma/client';

@Controller('homepage-sections')
export class HomepageSectionsController {
  constructor(private readonly homepageSectionsService: HomepageSectionsService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async findAllPublic() {
    const data = await this.homepageSectionsService.findAllPublic();
    return { message: 'Homepage sections retrieved successfully', data };
  }
}

@Controller('admin/homepage-sections')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class AdminHomepageSectionsController {
  constructor(private readonly homepageSectionsService: HomepageSectionsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateHomepageSectionDto) {
    const data = await this.homepageSectionsService.create(dto);
    return { message: 'Homepage section created successfully', data };
  }

  @Get()
  @HttpCode(HttpStatus.OK)
  async findAll() {
    const data = await this.homepageSectionsService.findAllAdmin();
    return { message: 'Homepage sections retrieved successfully', data };
  }

  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(@Body() dto: ReorderHomepageSectionsDto) {
    const data = await this.homepageSectionsService.reorder(dto.orderedIds);
    return { message: 'Homepage sections reordered successfully', data };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateHomepageSectionDto) {
    const data = await this.homepageSectionsService.update(id, dto);
    return { message: 'Homepage section updated successfully', data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async remove(@Param('id', ParseUUIDPipe) id: string) {
    const data = await this.homepageSectionsService.remove(id);
    return { message: 'Homepage section deleted successfully', data };
  }
}
