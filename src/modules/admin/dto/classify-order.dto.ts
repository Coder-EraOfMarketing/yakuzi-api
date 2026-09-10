import { IsIn } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * Which side of the test/real split one order sits on.
 *
 * 'auto' removes any override and hands the order back to the
 * TEST_BUYER_PHONES rule, so an admin can undo a mistake without having to
 * know what the rule would have decided.
 */
export class ClassifyOrderDto {
  @ApiProperty({ enum: ['real', 'test', 'auto'] })
  @IsIn(['real', 'test', 'auto'], {
    message: 'classification must be one of: real, test, auto',
  })
  classification: 'real' | 'test' | 'auto';
}
