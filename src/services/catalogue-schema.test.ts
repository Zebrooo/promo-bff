import { describe, expect, it } from 'vitest';
import { catalogueSchema, promoFormatSchema, promoSchema, queueSchema } from './catalogue-schema';
import type { PromoFormat } from '../promo-selector/types';
import { makePromo } from '../test-utils';

describe('promoSchema', () => {
  it('accepts a fully-valid promo', () => {
    expect(() => promoSchema.parse(makePromo())).not.toThrow();
  });

  it('rejects a negative cooldownHours', () => {
    expect(() => promoSchema.parse(makePromo({ cooldownHours: -1 }))).toThrow();
  });

  it('accepts an audience target', () => {
    expect(() => promoSchema.parse(makePromo({ audience: 'authenticated' }))).not.toThrow();
    expect(() => promoSchema.parse(makePromo({ audience: 'nope' as never }))).toThrow();
  });

  it('rejects a non-ISO startsAt', () => {
    expect(() => promoSchema.parse(makePromo({ startsAt: 'yesterday' }))).toThrow();
  });

  it('rejects an unknown format', () => {
    expect(() => promoSchema.parse(makePromo({ format: 'banner' as never }))).toThrow();
  });

  it('accepts the topline format', () => {
    expect(() => promoSchema.parse(makePromo({ format: 'topline' }))).not.toThrow();
  });

  it('rejects a promo missing required fields', () => {
    expect(() => promoSchema.parse({ id: 'x' })).toThrow();
  });

  it('accepts sections and categories arrays', () => {
    const parsed = promoSchema.parse(makePromo({ sections: ['avto'], categories: ['kvartiry'] }));
    expect(parsed.sections).toEqual(['avto']);
    expect(parsed.categories).toEqual(['kvartiry']);
  });

  it('rejects a non-string section', () => {
    expect(() => promoSchema.parse(makePromo({ sections: [1] as never }))).toThrow();
  });
});

describe('multistep format (steps)', () => {
  const step = (n: number) => ({ title: `Шаг ${n}`, body: `Текст ${n}` });

  it('accepts a multistep promo with 2..6 steps', () => {
    expect(() =>
      promoSchema.parse(makePromo({ format: 'multistep', steps: [step(1), step(2)] })),
    ).not.toThrow();
    expect(() =>
      promoSchema.parse(makePromo({
        format: 'multistep',
        steps: Array.from({ length: 6 }, (_, i) => step(i + 1)),
      })),
    ).not.toThrow();
  });

  it('rejects a multistep promo without steps (refine)', () => {
    expect(() => promoSchema.parse(makePromo({ format: 'multistep' }))).toThrow();
  });

  it('rejects fewer than 2 or more than 6 steps', () => {
    expect(() => promoSchema.parse(makePromo({ format: 'multistep', steps: [step(1)] }))).toThrow();
    expect(() =>
      promoSchema.parse(makePromo({
        format: 'multistep',
        steps: Array.from({ length: 7 }, (_, i) => step(i + 1)),
      })),
    ).toThrow();
  });

  it('rejects a step with an empty or over-limit title/body', () => {
    expect(() =>
      promoSchema.parse(makePromo({ format: 'multistep', steps: [{ title: '', body: 'x' }, step(2)] })),
    ).toThrow();
    expect(() =>
      promoSchema.parse(makePromo({ format: 'multistep', steps: [{ title: 'x', body: '' }, step(2)] })),
    ).toThrow();
    expect(() =>
      promoSchema.parse(makePromo({ format: 'multistep', steps: [{ title: 'т'.repeat(81), body: 'x' }, step(2)] })),
    ).toThrow();
    expect(() =>
      promoSchema.parse(makePromo({ format: 'multistep', steps: [{ title: 'x', body: 'т'.repeat(241) }, step(2)] })),
    ).toThrow();
  });

  it('does not require steps for non-multistep formats', () => {
    expect(() => promoSchema.parse(makePromo())).not.toThrow();
  });
});

describe('catalogueSchema', () => {
  it('accepts an ordered array of promos and preserves order', () => {
    const parsed = catalogueSchema.parse([makePromo({ id: 'a' }), makePromo({ id: 'b' })]);
    expect(parsed.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('rejects a non-array', () => {
    expect(() => catalogueSchema.parse({ id: 'a' })).toThrow();
  });
});

describe('queueSchema', () => {
  it('queueSchema accepts an array of id strings', () => {
    expect(() => queueSchema.parse(['a', 'b'])).not.toThrow();
    expect(() => queueSchema.parse([1, 2])).toThrow();
  });
});

/**
 * Runtime mirror of the PromoFormat union. Two compile-time guards keep it
 * honest: `satisfies` rejects typos/extras, and AssertExhaustive fails tsc if
 * the union gains a literal that is missing from this list.
 */
const ALL_PROMO_FORMATS = [
  'inline',
  'popup',
  'fullscreen',
  'topline',
  'banner',
  'divkit',
  'tooltip',
  'multistep',
] as const satisfies readonly PromoFormat[];

type MissingFromList = Exclude<PromoFormat, (typeof ALL_PROMO_FORMATS)[number]>;
type AssertExhaustive = [MissingFromList] extends [never] ? true : { missingLiterals: MissingFromList };
const _assertExhaustive: AssertExhaustive = true;
void _assertExhaustive;

describe('promoFormatSchema ↔ PromoFormat enum sync', () => {
  it("accepts every PromoFormat literal except the auction-only 'banner'", () => {
    // Contract: queue promos may use any domain format EXCEPT 'banner' — that
    // one is the paid auction creative, never served from the S3 queues. If
    // either side drifts (a format added to types.ts but not the schema, or
    // vice versa), this comparison fails.
    const queueFormats = ALL_PROMO_FORMATS.filter((f) => f !== 'banner');
    expect([...promoFormatSchema.options].sort()).toEqual([...queueFormats].sort());
  });
});
