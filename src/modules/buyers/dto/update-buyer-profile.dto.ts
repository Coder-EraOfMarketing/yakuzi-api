import {
  IsString,
  MaxLength,
  IsDateString,
  IsOptional,
  IsNumber,
  IsObject,
  IsArray,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateBuyerProfileDto {
  @ApiPropertyOptional({ example: 'MedPlus Pharmacy Pvt Ltd' })
  @IsOptional()
  @IsString()
  legalName?: string;

  @ApiPropertyOptional({ example: 'medplus123' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ example: 'medplus@example.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ example: '9876543210' })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: '27AABCU9603R1ZM' })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => !!o.gstNumber)
  @Matches(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/, {
    message: 'gstNumber must be a valid 15-character GSTIN',
  })
  gstNumber?: string;

  @ApiPropertyOptional({ example: 'ABCDE1234F' })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => !!o.panNumber)
  @Matches(/^[A-Z]{5}\d{4}[A-Z]{1}$/, {
    message: 'panNumber must be a valid 10-character PAN',
  })
  panNumber?: string;

  @ApiPropertyOptional({ example: 'DL-MH-2024-001234' })
  @IsOptional()
  @IsString()
  drugLicenseNumber?: string;

  @ApiPropertyOptional({ example: 'https://s3.amazonaws.com/drug-license.pdf' })
  @IsOptional()
  @IsString()
  drugLicenseUrl?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsString()
  drugLicenseExpiry?: string;

  @ApiPropertyOptional({ example: 'DL-MH-2024-001234' })
  @IsOptional()
  @IsString()
  drugLicenseNumber2?: string;

  @ApiPropertyOptional({
    example: 'https://s3.amazonaws.com/drug-license2.pdf',
  })
  @IsOptional()
  @IsString()
  drugLicenseUrl2?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsString()
  drugLicenseExpiry2?: string;

  @ApiPropertyOptional({ description: 'Structured address object' })
  @IsOptional()
  @IsObject()
  address?: Record<string, any>;

  /**
   * `@Type(() => Object)` is load-bearing, not decoration.
   *
   * main.ts builds the global pipe with `transform: true` and
   * `enableImplicitConversion: true`, and a property whose only reflected type
   * is `Array` has that type applied to its ELEMENTS as well: each licence was
   * constructed as an Array and, having no numeric keys, arrived as `[]`. A
   * body of `[{ number, expiry }]` reached the service as `[[]]`, so every
   * licence detail was dropped on save with no error. Naming the element type
   * is what stops the coercion; the rows stay free-form JSON.
   */
  @ApiPropertyOptional({ description: 'Drug licence details array' })
  @IsOptional()
  @IsArray()
  @Type(() => Object)
  licence?: Record<string, any>[];

  @ApiPropertyOptional({ description: 'Bank account details' })
  @IsOptional()
  @IsObject()
  bankAccount?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  cancelCheck?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  document?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  inviteCode?: string;

  @ApiPropertyOptional({ example: 'Mumbai' })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: 'Maharashtra' })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: '400001' })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => !!o.pincode)
  @Matches(/^\d{6}$/, { message: 'pincode must be a valid 6-digit code' })
  pincode?: string;

  @ApiPropertyOptional({ example: 19.076 })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ example: 72.8777 })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional({ description: 'Pre-verified IDFY response' })
  @IsOptional()
  @IsObject()
  gstPanResponse?: Record<string, any>;

  @ApiPropertyOptional({
    example: 'MALE',
    description:
      'Free-form to stay compatible with what signup collects; the buyer app sends MALE/FEMALE/OTHER/PREFER_NOT_TO_SAY. Empty string clears it.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  gender?: string;

  @ApiPropertyOptional({
    example: '2000-01-31',
    description: 'Date of birth (ISO date). Empty string clears it.',
  })
  @IsOptional()
  @ValidateIf((o) => !!o.dob)
  @IsDateString()
  dob?: string;
}
