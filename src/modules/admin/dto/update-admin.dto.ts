import { IsString, IsOptional, Length, IsObject } from 'class-validator';

export class UpdateAdminDto {
  @IsOptional()
  @IsString()
  @Length(2, 100)
  name?: string;

  @IsOptional()
  @IsString()
  department?: string;

  /** See CreateAdminDto - same shape, same validation path. */
  @IsOptional()
  @IsObject()
  access?: { isSuper?: boolean; tabs?: Record<string, string> };

  /** Legacy grant format; `access` wins if both are sent. */
  @IsOptional()
  @IsString()
  permissions?: string;
}
