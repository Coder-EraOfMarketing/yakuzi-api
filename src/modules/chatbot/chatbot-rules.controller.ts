import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';
import { ChatbotRulesService } from './chatbot-rules.service';
import { CreateChatbotRuleDto, ReorderChatbotRulesDto, UpdateChatbotRuleDto } from './chatbot-rules.dto';

@Controller('admin/chatbot/rules')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class ChatbotRulesController {
  constructor(private readonly rulesService: ChatbotRulesService) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  async list() {
    const data = await this.rulesService.list();
    return { message: 'Chatbot rules retrieved successfully', data };
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateChatbotRuleDto) {
    const data = await this.rulesService.create(dto);
    return { message: 'Chatbot rule created successfully', data };
  }

  // Declared before ':id' — NestJS matches routes in declaration order, so
  // putting ':id' first would swallow PATCH .../reorder as id="reorder".
  @Patch('reorder')
  @HttpCode(HttpStatus.OK)
  async reorder(@Body() dto: ReorderChatbotRulesDto) {
    const data = await this.rulesService.reorder(dto.tier, dto.orderedIds);
    return { message: 'Chatbot rules reordered successfully', data };
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateChatbotRuleDto) {
    const data = await this.rulesService.update(id, dto);
    return { message: 'Chatbot rule updated successfully', data };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async delete(@Param('id', ParseUUIDPipe) id: string) {
    await this.rulesService.delete(id);
    return { message: 'Chatbot rule deleted successfully' };
  }

  @Delete()
  @HttpCode(HttpStatus.OK)
  async deleteAll() {
    await this.rulesService.deleteAll();
    return { message: 'All chatbot rules cleared — bot reset to its default persona.' };
  }
}
