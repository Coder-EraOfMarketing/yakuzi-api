import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { AdminAccessGuard } from '../../common/admin-access/admin-access.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { ChatbotConfigService, DEFAULT_CONFIG } from './chatbot-config.service';
import { PreviewChatbotConfigDto, UpdateChatbotConfigDto } from './chatbot-config.dto';
import { allowedTools, compileSystemInstruction, type PersonaConfig } from './persona-compiler';

/**
 * The Chatbot Studio's back end.
 *
 * Mounted under /admin so the existing permission rules for the "chatbot" tab
 * apply unchanged (admin-route-map.ts already covers /admin/chatbot/*).
 */
@ApiTags('Chatbot Studio')
@ApiBearerAuth('JWT-auth')
@Controller('admin/chatbot')
@UseGuards(JwtAuthGuard, RolesGuard, AdminAccessGuard)
@Roles(Role.ADMIN)
export class ChatbotConfigController {
  constructor(private readonly configService: ChatbotConfigService) {}

  @Get('config')
  @ApiOperation({ summary: 'Everything the assistant is currently configured to do' })
  @ApiResponse({ status: 200, description: 'Settings returned' })
  async get() {
    const data = await this.configService.get();
    return { message: 'Chatbot settings retrieved', data };
  }

  @Patch('config')
  @ApiOperation({ summary: 'Save a section of the settings' })
  @ApiResponse({ status: 200, description: 'Settings saved' })
  async update(
    @Body() dto: UpdateChatbotConfigDto,
    @CurrentUser('id') adminId: string,
  ) {
    const data = await this.configService.update(dto, adminId);
    return { message: 'Chatbot settings saved', data };
  }

  /**
   * What these settings actually tell the model — the exact text, before
   * anything is saved.
   *
   * This is the difference between a settings screen and a training tool: the
   * admin moves a dial and sees the sentence it produces, so the thing they are
   * configuring stops being a black box.
   */
  @Post('config/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Compile settings into the assistant’s instructions, without saving' })
  @ApiResponse({ status: 200, description: 'Compiled instructions returned' })
  async preview(@Body() dto: PreviewChatbotConfigDto) {
    const saved = await this.configService.get();
    // Anything the Studio did not send keeps its saved value, so a preview of
    // one panel reflects the whole assistant rather than that panel alone.
    const merged = { ...DEFAULT_CONFIG, ...saved, ...dto } as PersonaConfig &
      typeof DEFAULT_CONFIG;

    const runtime = await this.configService.buildRuntime(merged);

    return {
      message: 'Preview generated',
      data: {
        systemInstruction: runtime.systemInstruction,
        tools: allowedTools(merged),
        // Shown as "roughly N words of instructions" so an admin can see when
        // they have written so much that the important parts get diluted.
        instructionWords: compileSystemInstruction(merged, []).split(/\s+/).length,
      },
    };
  }

  @Get('usage')
  @ApiOperation({ summary: "Today's chat volume against the configured caps" })
  @ApiResponse({ status: 200, description: 'Usage returned' })
  async usage() {
    const data = await this.configService.usageSummary();
    return { message: 'Chatbot usage retrieved', data };
  }
}
