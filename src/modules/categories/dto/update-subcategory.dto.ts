import { IsString, IsOptional, MaxLength, IsBoolean } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateSubCategoryDto {
  @ApiPropertyOptional({ example: 'Tablets' })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  /**
   * Renaming a sub-category regenerates its slug, changing the public
   * /category/<parentSlug>/<subSlug> URL. When that happens, 301 the old URL
   * to the new one. Default true; false skips only the redirect creation.
   * Mirrors UpdateCategoryDto.slugRedirect.
   */
  @IsOptional()
  @IsBoolean()
  slugRedirect?: boolean;
}
