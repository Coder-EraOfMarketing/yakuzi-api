import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  HttpStatus,
  Ip,
  UseGuards,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ChatbotService } from './chatbot.service';
import { ChatbotConfigService } from './chatbot-config.service';
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
  constructor(
    private readonly chatbotService: ChatbotService,
    private readonly configService: ChatbotConfigService,
  ) {}

  private getSidecarUrl(): string {
    return process.env.CHATBOT_API_URL || 'http://127.0.0.1:5005';
  }

  /**
   * One visitor, for the purposes of a daily limit.
   *
   * The storefront sends X-Visitor-Id (already an allowed CORS header); when it
   * does not, the caller's IP is hashed so the counter never stores an address.
   * Neither is an identity — it only has to be stable for a day.
   */
  private visitorKey(visitorId?: string, ip?: string): string {
    const raw = (visitorId || '').trim();
    if (raw) return `v:${raw.slice(0, 64)}`;
    return `ip:${createHash('sha256').update(ip || 'unknown').digest('hex').slice(0, 32)}`;
  }

  @Post('chat')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send message to AI chatbot' })
  @ApiResponse({ status: 200, description: 'AI response returned' })
  async chat(
    @Body() dto: ChatRequestDto,
    @Headers('x-visitor-id') visitorId?: string,
    @Ip() ip?: string,
  ) {
    // Switched off, site over its daily ceiling, or this visitor over theirs.
    // Answered in the assistant's own voice rather than as an error, because
    // this is a chat window: a red 429 in a speech bubble helps nobody.
    const decision = await this.configService.authorizeMessage(
      this.visitorKey(visitorId, ip),
    );
    if (!decision.allowed) {
      return { response: decision.message, limited: true, reason: decision.reason };
    }

    const config = decision.config;

    // Everything below is clamped by the Studio's settings, never by the
    // caller. Before this, a stranger could post an unbounded message with any
    // thinking budget they liked — straight onto the store's AI bill.
    const message = (dto.message || '').slice(0, config.maxMessageLength);
    const history = (dto.history || []).slice(-Math.max(0, config.maxHistoryTurns));
    const runtime = await this.configService.buildRuntime(config);

    const result = await this.chatbotService.sendMessage(
      message,
      history,
      dto.attachments || [],
      {
        thinkingEnabled: config.thinkingEnabled && dto.thinkingEnabled !== false,
        thinkingBudget: Math.min(
          dto.thinkingBudget ?? config.thinkingBudgetCap,
          config.thinkingBudgetCap,
        ),
        systemInstruction: runtime.systemInstruction,
        tools: runtime.tools,
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
