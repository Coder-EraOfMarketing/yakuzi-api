import { IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class AdminQueryAbandonedCheckoutsDto {
  @ApiPropertyOptional({
    enum: ['abandoned', 'in_progress', 'all'],
    default: 'abandoned',
    description:
      '"abandoned" = given up and cancelled (the settled history); "in_progress" = still inside the payment window, so not worth chasing yet; "all" = both.',
  })
  @IsOptional()
  @IsIn(['abandoned', 'in_progress', 'all'])
  state?: 'abandoned' | 'in_progress' | 'all';

  @ApiPropertyOptional({ description: 'Matches buyer phone, name or email.' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ example: '2026-10-01', description: 'Checkout started on or after (ISO).' })
  @IsOptional()
  @IsString()
  dateFrom?: string;

  @ApiPropertyOptional({ example: '2026-10-31', description: 'Checkout started on or before (ISO).' })
  @IsOptional()
  @IsString()
  dateTo?: string;

  @ApiPropertyOptional({
    example: 'false',
    description: 'Set to "true" to include internal test accounts (excluded by default).',
  })
  @IsOptional()
  @IsIn(['true', 'false'])
  includeTestOrders?: string;

  @ApiPropertyOptional({ example: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ example: 20, default: 20, description: 'Items per page (max 100)' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}
