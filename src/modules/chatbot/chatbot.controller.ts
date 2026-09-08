import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ChatbotService } from './chatbot.service';
import {
  IsString,
  IsNotEmpty,
  IsArray,
  IsOptional,
  ValidateNested,
  IsBoolean,
  IsNumber,
} from 'class-validator';
import { Type } from 'class-transformer';
import axios from 'axios';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access';
import { Roles } from '../../common/decorators/roles.decorator';

export class AttachmentDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  @IsNotEmpty()
  data: string;

  @IsString()
  @IsNotEmpty()
  type: string;
}

export class ChatMessageDto {
  @IsString()
  @IsNotEmpty()
  role: string;

  @IsString()
  @IsOptional()
  content?: string;

  @IsString()
  @IsOptional()
  thoughts?: string;

  @IsNumber()
  @IsOptional()
  thinkingTimeMs?: number;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];
}

export class ChatRequestDto {
  @IsString()
  @IsOptional()
  message?: string;

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => ChatMessageDto)
  history?: ChatMessageDto[];

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => AttachmentDto)
  attachments?: AttachmentDto[];

  @IsBoolean()
  @IsOptional()
  thinkingEnabled?: boolean;

  @IsNumber()
  @IsOptional()
  thinkingBudget?: number;
}

@ApiTags('Chatbot')
@Controller('chatbot')
export class ChatbotController {
  constructor(private readonly chatbotService: ChatbotService) {}

  private getSidecarUrl(): string {
    return process.env.CHATBOT_API_URL || 'http://127.0.0.1:5005';
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send message to AI chatbot' })
  @ApiResponse({ status: 200, description: 'AI response returned' })
  async chat(@Body() dto: ChatRequestDto) {
    const result = await this.chatbotService.sendMessage(
      dto.message || '',
      dto.history || [],
      dto.attachments || [],
      {
        thinkingEnabled: dto.thinkingEnabled,
        thinkingBudget: dto.thinkingBudget,
      },
    );
    return result;
  }

  @Post('train/extract')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
  @Roles(Role.ADMIN)
  @ApiOperation({ summary: 'Extract a {trigger, instruction} draft from a sandbox conversation' })
  async trainExtract(@Body() dto: { history: any[] }) {
    try {
      const response = await axios.post(`${this.getSidecarUrl()}/train/extract`, dto);
      return response.data;
    } catch (error: any) {
      if (error.response) {
        throw new Error(
          `Python sidecar error: ${JSON.stringify(error.response.data)}`,
        );
      }
      throw new Error(
        `Failed to communicate with Python sidecar: ${error.message}`,
      );
    }
  }
}
