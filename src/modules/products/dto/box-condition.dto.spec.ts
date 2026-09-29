import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
import { UpdateProductDto } from './update-product.dto';

/**
 * The box condition is mandatory, but the column is nullable — so nothing in
 * the database enforces it. These tests are the enforcement: if they pass and
 * the DTO later loses its decorator, a listing can be created with no answer
 * and the storefront silently shows no tag.
 */

/** A create payload that is valid apart from the field under test. */
const baseCreate = {
  name: 'Luffy & Shanks Figure',
  categoryId: 'cat-1',
  subCategoryId: 'sub-1',
  manufacturer: 'Banpresto',
  mrp: 620,
  gstPercent: 12,
};

const failedProperties = async (cls: any, payload: unknown): Promise<string[]> => {
  const dto = plainToInstance(cls, payload);
  const errors = await validate(dto as object);
  return errors.map((e) => e.property);
};

describe('boxCondition validation', () => {
  it('rejects a create with no boxCondition', async () => {
    expect(await failedProperties(CreateProductDto, { ...baseCreate })).toContain(
      'boxCondition',
    );
  });

  it('rejects a value outside the enum', async () => {
    expect(
      await failedProperties(CreateProductDto, {
        ...baseCreate,
        boxCondition: 'MAYBE_BOX',
      }),
    ).toContain('boxCondition');
  });

  it('accepts WITH_BOX', async () => {
    expect(
      await failedProperties(CreateProductDto, {
        ...baseCreate,
        boxCondition: 'WITH_BOX',
      }),
    ).not.toContain('boxCondition');
  });

  it('accepts WITHOUT_BOX', async () => {
    expect(
      await failedProperties(CreateProductDto, {
        ...baseCreate,
        boxCondition: 'WITHOUT_BOX',
      }),
    ).not.toContain('boxCondition');
  });

  // Editing an unrelated field must not force a seller to re-answer, which is
  // why the update DTO leaves it optional.
  it('accepts an update with no boxCondition', async () => {
    expect(await failedProperties(UpdateProductDto, { mrp: 700 })).not.toContain(
      'boxCondition',
    );
  });

  it('still rejects a bad value on update when one is given', async () => {
    expect(
      await failedProperties(UpdateProductDto, { boxCondition: 'MAYBE_BOX' }),
    ).toContain('boxCondition');
  });
});
