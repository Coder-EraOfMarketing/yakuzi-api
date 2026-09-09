import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpsertSeoMetaDto } from './seo.dto';

/**
 * These run the body through the SAME transform options main.ts gives the
 * global ValidationPipe. Without `@Type()` on `faq`, every entry came out of
 * the pipe as `[]` — the questions and answers were gone before any service
 * or Prisma code ran, which is why saved FAQs never reached a page.
 */
const PIPE_OPTIONS = { enableImplicitConversion: true } as const;

const parse = (body: Record<string, unknown>) =>
  plainToInstance(UpsertSeoMetaDto, body, PIPE_OPTIONS);

describe('UpsertSeoMetaDto', () => {
  const base = { entityType: 'PRODUCT', entityId: 'prod-1' };

  it('keeps FAQ entries as objects through the validation pipe', () => {
    const faq = [
      { question: 'Is it in stock?', answer: 'Yes, ships in 48 hours.' },
      { question: 'Is there a warranty?', answer: 'One year, seller-backed.' },
    ];

    const dto = parse({ ...base, faq });

    expect(dto.faq).toEqual(faq);
    expect(validateSync(dto)).toHaveLength(0);
  });

  it('rejects an entry that is missing its answer', () => {
    const dto = parse({ ...base, faq: [{ question: 'Is it in stock?' }] });

    expect(validateSync(dto).length).toBeGreaterThan(0);
  });

  /**
   * class-validator does not fault an array-shaped entry here, so the DTO is
   * not the last line of defence: SeoService.normalizeFields drops rows that
   * carry no question or answer before anything is written.
   */
  it('does not fault an array-shaped entry (the service filters those)', () => {
    const dto = parse({ ...base, faq: [[]] });

    expect(validateSync(dto)).toHaveLength(0);
  });

  it('leaves the sibling array and object fields alone', () => {
    const dto = parse({
      ...base,
      secondaryKeywords: ['helmet', 'ironman'],
      imageAltOverrides: { 'a.jpg': 'Iron Man helmet' },
    });

    expect(dto.secondaryKeywords).toEqual(['helmet', 'ironman']);
    expect(dto.imageAltOverrides).toEqual({ 'a.jpg': 'Iron Man helmet' });
  });
});
