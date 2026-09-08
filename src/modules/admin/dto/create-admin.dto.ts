import { IsString, IsPhoneNumber, IsOptional, Length, IsObject } from 'class-validator';

/**
 * Tab-level access as the grant screen sends it:
 *   { isSuper: true }
 *   { isSuper: false, tabs: { orders: 'partial', tickets: 'full' } }
 *
 * Validated in AdminService.resolveGrantsForWrite (unknown tab keys and bad
 * levels come back as a 400) rather than with nested class-validator rules,
 * because `tabs` is keyed by tab name, not by a fixed field list.
 */
export class CreateAdminDto {
  @IsPhoneNumber('IN')
  phone: string;

  @IsString()
  @Length(2, 100)
  name: string;

  @IsOptional()
  @IsString()
  department?: string;

  @IsOptional()
  @IsObject()
  access?: { isSuper?: boolean; tabs?: Record<string, string> };

  /**
   * Legacy grant format ("1 3 5 x"). Still accepted so the previous admin
   * screen keeps working until the new one ships; `access` wins if both are
   * sent.
   */
  @IsOptional()
  @IsString()
  permissions?: string;
}
