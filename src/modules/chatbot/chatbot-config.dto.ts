import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * Every field optional: the Studio saves one section at a time, and a partial
 * save must never blank the sections the admin was not looking at.
 *
 * The ceilings are not arbitrary. `maxMessagesPerDay` and the thinking budget
 * are the two settings that decide what a day of traffic costs, so they are
 * bounded here as well as in the UI — a bad number typed into this endpoint
 * directly would otherwise become a bill.
 */
export class UpdateChatbotConfigDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(60)
  assistantName?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  greeting?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(140)
  tagline?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  formality?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  warmth?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  detail?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  emoji?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 100 })
  @IsOptional() @IsInt() @Min(0) @Max(100)
  salesiness?: number;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(10) @IsString({ each: true }) @MaxLength(40, { each: true })
  languages?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(300, { each: true })
  neverSay?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(300, { each: true })
  alwaysDo?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsString({ each: true }) @MaxLength(120, { each: true })
  blockedTopics?: string[];

  @ApiPropertyOptional() @IsOptional() @IsBoolean() canSearchProducts?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canReadReviews?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canReadBlogs?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canCheckOrders?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canAnswerOffTopic?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() canQuotePrices?: boolean;

  /** 0 = unlimited. Capped so one typo cannot open the taps completely. */
  @ApiPropertyOptional({ minimum: 0, maximum: 5000 })
  @IsOptional() @IsInt() @Min(0) @Max(5000)
  maxMessagesPerVisitorPerDay?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 200000 })
  @IsOptional() @IsInt() @Min(0) @Max(200000)
  maxMessagesPerDay?: number;

  @ApiPropertyOptional({ minimum: 50, maximum: 8000 })
  @IsOptional() @IsInt() @Min(50) @Max(8000)
  maxMessageLength?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 50 })
  @IsOptional() @IsInt() @Min(0) @Max(50)
  maxHistoryTurns?: number;

  /** The single biggest lever on what one answer costs. */
  @ApiPropertyOptional({ minimum: 0, maximum: 8192 })
  @IsOptional() @IsInt() @Min(0) @Max(8192)
  thinkingBudgetCap?: number;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() thinkingEnabled?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  limitReachedMessage?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(500)
  unavailableMessage?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() isEnabled?: boolean;

  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(4000)
  extraInstructions?: string;
}

/** Body for the Studio's "try it" preview, which never touches the saved row. */
export class PreviewChatbotConfigDto extends UpdateChatbotConfigDto {}
