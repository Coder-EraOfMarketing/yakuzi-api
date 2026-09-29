import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateProductDto } from './create-product.dto';
import { UpdateProductDto } from './update-product.dto';

/**
 * The box condition is meant to be mandatory, and the column is nullable, so
 * nothing in the database enforces it — the DTO decorators do.
 *
 * ⚠️ It is NOT yet required on create, deliberately. This API and the seller
 * portal deploy separately and merging means live, so requiring it before the
 * form sends it would 400 every product creation, and shipping the form first
 * would trip `forbidNonWhitelisted` on the global pipe. It lands additive
 * first; a follow-up flips it to required once no live client can omit it.
 *
 * The test below named "accepts a create with no boxCondition (FOR NOW)" is
 * the reminder. When the follow-up lands, invert it to expect rejection — if
 * that test still passes unchanged, the contract step never happened.
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
  // FOR NOW. Invert this to `.toContain` when the follow-up makes the field
  // required, which is safe once the seller form is live and always sends it.
  // If this test is still passing as written after that, the contract step was
  // skipped and "mandatory" is client-side only.
  it('accepts a create with no boxCondition (FOR NOW — see file header)', async () => {
    expect(
      await failedProperties(CreateProductDto, { ...baseCreate }),
    ).not.toContain('boxCondition');
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
