import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ChatbotController } from './chatbot.controller';
import { ChatbotService } from './chatbot.service';
import { ChatbotRulesController } from './chatbot-rules.controller';
import { ChatbotRulesService } from './chatbot-rules.service';
import { ChatbotConfigController } from './chatbot-config.controller';
import { ChatbotConfigService } from './chatbot-config.service';
import { DatabaseModule } from '../../database/database.module';

@Module({
  imports: [ConfigModule, DatabaseModule],
  controllers: [ChatbotController, ChatbotRulesController, ChatbotConfigController],
  providers: [ChatbotService, ChatbotRulesService, ChatbotConfigService],
  exports: [ChatbotService, ChatbotConfigService],
})
export class ChatbotModule {}
