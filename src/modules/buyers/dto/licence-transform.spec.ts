import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { CreateBuyerProfileDto } from './create-buyer-profile.dto';
import { UpdateBuyerProfileDto } from './update-buyer-profile.dto';

/**
 * The transform options main.ts gives the global ValidationPipe. Without
 * `@Type()` on `licence`, implicit conversion rebuilt each row as an empty
 * array, so a saved drug licence reached the service as [[]] — every detail
 * dropped, no error raised.
 */
const PIPE_OPTIONS = { enableImplicitConversion: true } as const;

const LICENCE = [
  { type: 'DL20B', number: 'DL-20B-12345', expiry: '2026-12-31' },
  { type: 'DL21B', number: 'DL-21B-67890', expiry: '2027-06-30' },
];

describe('buyer profile licence rows survive the validation pipe', () => {
  it('on create', () => {
    const dto = plainToInstance(
      CreateBuyerProfileDto,
      { licence: LICENCE },
      PIPE_OPTIONS,
    );

    expect(dto.licence).toEqual(LICENCE);
  });

  it('on update', () => {
    const dto = plainToInstance(
      UpdateBuyerProfileDto,
      { licence: LICENCE },
      PIPE_OPTIONS,
    );

    expect(dto.licence).toEqual(LICENCE);
  });

  it('keeps rows free-form — unknown keys are not stripped', () => {
    const dto = plainToInstance(
      UpdateBuyerProfileDto,
      { licence: [{ number: 'DL-1', issuedBy: 'State FDA', scans: ['a.jpg'] }] },
      PIPE_OPTIONS,
    );

    expect(dto.licence).toEqual([
      { number: 'DL-1', issuedBy: 'State FDA', scans: ['a.jpg'] },
    ]);
  });
});
