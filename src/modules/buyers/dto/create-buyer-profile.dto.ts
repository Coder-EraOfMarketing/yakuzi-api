import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsNumber,
  IsObject,
  IsArray,
  Matches,
  ValidateIf,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateBuyerProfileDto {
  @ApiProperty({ example: '9876543210', description: 'Buyer phone number' })
  @IsString()
  @IsNotEmpty()
  phone: string;

  @ApiProperty({ example: 'Rajesh Kumar' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ example: 'buyer@example.com' })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiProperty({ example: 'MediCorp Pharma Pvt Ltd' })
  @IsString()
  @IsNotEmpty()
  legalName: string;

  @ApiPropertyOptional({
    example: '27AABCU9603R1ZM',
    description: '15-char GSTIN (required if no PAN)',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => !!o.gstNumber)
  @Matches(/^\d{2}[A-Z]{5}\d{4}[A-Z]{1}[A-Z\d]{1}[Z]{1}[A-Z\d]{1}$/, {
    message: 'gstNumber must be a valid 15-character GSTIN',
  })
  gstNumber?: string;

  @ApiPropertyOptional({
    example: 'ABCDE1234F',
    description: '10-char PAN (required if no GST)',
  })
  @IsOptional()
  @IsString()
  @ValidateIf((o) => !!o.panNumber)
  @Matches(/^[A-Z]{5}\d{4}[A-Z]{1}$/, {
    message: 'panNumber must be a valid 10-character PAN',
  })
  panNumber?: string;

  @ApiPropertyOptional({
    example: '123456789012',
    description: '12-digit Aadhaar Card number',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{12}$/, {
    message: 'aadhaarNumber must be a valid 12-digit number',
  })
  aadhaarNumber?: string;

  @ApiPropertyOptional({ example: 'DL-MH-123456' })
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

  @ApiPropertyOptional({ example: 'DL-MH-123456' })
  @IsOptional()
  @IsString()
  drugLicenseNumber2?: string;

  @ApiPropertyOptional({ example: 'https://s3.amazonaws.com/drug-license2.pdf' })
  @IsOptional()
  @IsString()
  drugLicenseUrl2?: string;

  @ApiPropertyOptional({ example: '2026-12-31' })
  @IsOptional()
  @IsString()
  drugLicenseExpiry2?: string;

  @ApiPropertyOptional({
    description: 'Structured address object',
    example: {
      street1: '123 MG Road',
      street2: 'Andheri East',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400069',
    },
  })
  @IsOptional()
  @IsObject()
  address?: Record<string, any>;

  @ApiPropertyOptional({
    description: 'Drug licence details array',
    example: [
      {
        type: 'DL20B',
        number: 'DL-20B-12345',
        expiry: '2026-12-31',
        imgUrl: 'https://...',
      },
    ],
  })
  // @Type(() => Object) is load-bearing — see UpdateBuyerProfileDto.licence.
  // Without it the pipe's implicit conversion rebuilds every licence as an
  // empty array, and the example above saves as [[]].
  @IsOptional()
  @IsArray()
  @Type(() => Object)
  licence?: Record<string, any>[];

  @ApiPropertyOptional({
    description: 'Bank account details',
    example: {
      accountNumber: '1234567890',
      ifsc: 'SBIN0001234',
      bankName: 'SBI',
      branch: 'Andheri',
      holderName: 'Rajesh Kumar',
    },
  })
  @IsOptional()
  @IsObject()
  bankAccount?: Record<string, any>;

  @ApiPropertyOptional({ example: 'https://s3.amazonaws.com/cancel-check.jpg' })
  @IsOptional()
  @IsString()
  cancelCheck?: string;

  @ApiPropertyOptional({ example: 'https://s3.amazonaws.com/document.pdf' })
  @IsOptional()
  @IsString()
  document?: string;

  @ApiPropertyOptional({ example: 'INV-SELLER-001' })
  @IsOptional()
  @IsString()
  inviteCode?: string;

  @ApiPropertyOptional({ example: 19.076 })
  @IsOptional()
  @IsNumber()
  latitude?: number;

  @ApiPropertyOptional({ example: 72.8777 })
  @IsOptional()
  @IsNumber()
  longitude?: number;

  @ApiPropertyOptional({
    description: 'Pre-verified IDFY response (from /verification/pangst)',
  })
  @IsOptional()
  @IsObject()
  gstPanResponse?: Record<string, any>;
}
