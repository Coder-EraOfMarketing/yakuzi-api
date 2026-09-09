/**
 * Pure scoring functions for SeoMeta records. No I/O — recomputed on every
 * admin save and stored on the row so list views don't recompute.
 * All scores are 0–100; readability is null when there is nothing to read.
 */

export interface ScorableMeta {
  title?: string | null;
  description?: string | null;
  focusKeyword?: string | null;
  secondaryKeywords?: string[] | null;
  entityDescription?: string | null;
  aiSummary?: string | null;
  faq?: unknown;
}

export interface FaqEntry {
  question: string;
  answer: string;
}

/**
 * The well-formed rows of a stored `faq` value, in order.
 *
 * Stored FAQs are not all trustworthy: rows saved before the DTO carried
 * `@Type()` were flattened to `[]` by the validation pipe (see SeoFaqEntryDto),
 * so live records hold shapes like `[[], [], [], []]`. Reads run through here
 * so those never reach an editor as blank rows or a page as empty questions.
 * Mirrors validFaqs() on the storefront.
 */
export function validFaqEntries(faq: unknown): FaqEntry[] {
  if (!Array.isArray(faq)) return [];
  return faq.filter(
    (f): f is FaqEntry =>
      !!f &&
      typeof f === 'object' &&
      !Array.isArray(f) &&
      typeof (f as { question?: unknown }).question === 'string' &&
      (f as { question: string }).question.trim() !== '' &&
      typeof (f as { answer?: unknown }).answer === 'string' &&
      (f as { answer: string }).answer.trim() !== '',
  );
}

export function faqCount(faq: unknown): number {
  return validFaqEntries(faq).length;
}

/**
 * Classic on-page checks. Weights sum to exactly 100:
 * title 20 + title-length 10 + description 20 + description-length 10 +
 * focus keyword 10 + keyword-in-title 10 + secondary keywords 5 +
 * entity description 10 + FAQ 5.
 */
export function computeSeoScore(m: ScorableMeta): number {
  let score = 0;
  const title = (m.title ?? '').trim();
  const description = (m.description ?? '').trim();
  const keyword = (m.focusKeyword ?? '').trim();

  if (title) {
    score += 20;
    if (title.length >= 15 && title.length <= 60) score += 10;
  }
  if (description) {
    score += 20;
    if (description.length >= 50 && description.length <= 160) score += 10;
  }
  if (keyword) {
    score += 10;
    if (title.toLowerCase().includes(keyword.toLowerCase())) score += 10;
  }
  if (m.secondaryKeywords && m.secondaryKeywords.length > 0) score += 5;
  if ((m.entityDescription ?? '').trim()) score += 10;
  if (faqCount(m.faq) > 0) score += 5;
  return score;
}

/**
 * How much machine-quotable substance exists for AI engines:
 * aiSummary 30 + substantial-summary 10 + entityDescription 25 +
 * FAQ 5/entry (max 25) + substantial description 10.
 */
export function computeAiVisibilityScore(m: ScorableMeta): number {
  let score = 0;
  const aiSummary = (m.aiSummary ?? '').trim();
  if (aiSummary) {
    score += 30;
    if (aiSummary.length >= 80) score += 10;
  }
  if ((m.entityDescription ?? '').trim()) score += 25;
  score += Math.min(faqCount(m.faq), 5) * 5;
  if ((m.description ?? '').trim().length >= 80) score += 10;
  return Math.min(100, score);
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const stripped = w.replace(/(?:[^laeiouy]e|ed|es)$/, '');
  const groups = stripped.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/** Flesch Reading Ease over every prose field, clamped to 0–100. */
export function computeReadabilityScore(m: ScorableMeta): number | null {
  const text = [m.description, m.entityDescription, m.aiSummary]
    .map((t) => (t ?? '').trim())
    .filter(Boolean)
    .join(' ');
  if (!text) return null;
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;
  const sentences = Math.max(1, (text.match(/[.!?]+(?:\s|$)/g) ?? []).length);
  const syllables = words.reduce((n, w) => n + countSyllables(w), 0);
  const flesch =
    206.835 - 1.015 * (words.length / sentences) - 84.6 * (syllables / words.length);
  return Math.round(Math.min(100, Math.max(0, flesch)));
}
