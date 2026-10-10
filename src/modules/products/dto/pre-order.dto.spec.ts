import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
import { UpdateProductDto } from './update-product.dto';

/**
 * `preOrderDeliveryDate` has to exist on BOTH DTOs or editing breaks.
 *
 * The global pipe runs with `forbidNonWhitelisted: true` and the shared
 * product form resends its entire payload on every save. A field accepted on
 * create but unknown on update therefore turns every edit of a pre-order
 * listing into a 400 — which is exactly the failure this file exists to
 * catch.
 */

const baseCreate = {
  name: 'Luffy Gear 5 Figure',
  categoryId: 'cat-1',
  subCategoryId: 'sub-1',
  manufacturer: 'Banpresto',
  mrp: 4200,
  gstPercent: 12,
  stock: 0,
};

const failedProperties = async (cls: any, payload: unknown): Promise<string[]> => {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto as object);
  return errors.map((e) => e.property);
};

describe('preOrderDeliveryDate validation', () => {
  it('accepts a create with an ISO date', async () => {
    expect(
      await failedProperties(CreateProductDto, {
        ...baseCreate,
        preOrderDeliveryDate: '2026-12-15T00:00:00.000Z',
      }),
    ).not.toContain('preOrderDeliveryDate');
  });

  it('accepts a create with no date at all — most listings are not pre-orders', async () => {
    expect(
      await failedProperties(CreateProductDto, { ...baseCreate }),
    ).not.toContain('preOrderDeliveryDate');
  });

  it('rejects a value that is not a date', async () => {
    expect(
      await failedProperties(CreateProductDto, {
        ...baseCreate,
        preOrderDeliveryDate: 'next christmas',
      }),
    ).toContain('preOrderDeliveryDate');
  });

  it('accepts the field on update', async () => {
    expect(
      await failedProperties(UpdateProductDto, {
        preOrderDeliveryDate: '2026-12-15T00:00:00.000Z',
      }),
    ).not.toContain('preOrderDeliveryDate');
  });

  // This is how a seller turns pre-order OFF: the form sends an explicit
  // null. @IsOptional() ignores null as well as undefined, so it validates,
  // and the service distinguishes "null means clear it" from "undefined
  // means leave it alone".
  it('accepts an explicit null on update, which is how pre-order is cleared', async () => {
    expect(
      await failedProperties(UpdateProductDto, { preOrderDeliveryDate: null }),
    ).not.toContain('preOrderDeliveryDate');
  });

  it('still rejects a bad value on update', async () => {
    expect(
      await failedProperties(UpdateProductDto, { preOrderDeliveryDate: 'soon' }),
    ).toContain('preOrderDeliveryDate');
  });
});
