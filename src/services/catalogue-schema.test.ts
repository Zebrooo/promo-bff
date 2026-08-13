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

  it('accepts the custom format with a variant', () => {
    const parsed = promoSchema.parse(makePromo({ format: 'custom', variant: 'reklama-onboarding' }));
    expect(parsed.format).toBe('custom');
    expect(parsed.variant).toBe('reklama-onboarding');
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

  it('accepts and trims bounded search targeting', () => {
    const parsed = promoSchema.parse(makePromo({
      targeting: {
        search: {
          terms: ['  Toyota Camry  ', 'внедорожник'],
          sections: ['  avto  '],
          match: 'all',
          lookbackDays: 14,
        },
      },
    }));
    expect(parsed.targeting.search).toEqual({
      terms: ['Toyota Camry', 'внедорожник'],
      sections: ['avto'],
      match: 'all',
      lookbackDays: 14,
    });
  });

  it('rejects invalid search targeting bounds and match mode', () => {
    const parseSearch = (search: Record<string, unknown>) =>
      promoSchema.parse(makePromo({ targeting: { search } as never }));

    expect(() => parseSearch({ terms: ['x'] })).toThrow();
    expect(() => parseSearch({ terms: ['--'] })).toThrow();
    expect(() => parseSearch({ terms: ['C++'] })).toThrow();
    expect(() => parseSearch({ terms: ['x'.repeat(81)] })).toThrow();
    expect(() => parseSearch({ terms: Array.from({ length: 21 }, () => 'ok') })).toThrow();
    expect(() => parseSearch({ sections: [''] })).toThrow();
    expect(() => parseSearch({ sections: ['-'] })).toThrow();
    expect(() => parseSearch({ sections: ['x'.repeat(41)] })).toThrow();
    expect(() => parseSearch({ sections: Array.from({ length: 21 }, () => 'avto') })).toThrow();
    expect(() => parseSearch({ match: 'some' })).toThrow();
    expect(() => parseSearch({ lookbackDays: 0 })).toThrow();
    expect(() => parseSearch({ lookbackDays: 31 })).toThrow();
    expect(() => parseSearch({ lookbackDays: 1.5 })).toThrow();
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

  it('accepts an optional per-step imageUrl (http(s) picture/gif)', () => {
    const parsed = promoSchema.parse(makePromo({
      format: 'multistep',
      steps: [{ ...step(1), imageUrl: 'https://cdn.example.com/step-1.gif' }, step(2)],
    }));
    expect(parsed.steps?.[0].imageUrl).toBe('https://cdn.example.com/step-1.gif');
    expect(parsed.steps?.[1].imageUrl).toBeUndefined();
  });

  it('rejects a step imageUrl that is not a URL or is over 1024 chars', () => {
    expect(() =>
      promoSchema.parse(makePromo({
        format: 'multistep',
        steps: [{ ...step(1), imageUrl: 'not-a-url' }, step(2)],
      })),
    ).toThrow();
    expect(() =>
      promoSchema.parse(makePromo({
        format: 'multistep',
        steps: [{ ...step(1), imageUrl: `https://cdn.example.com/${'x'.repeat(1024)}.png` }, step(2)],
      })),
    ).toThrow();
  });
});

describe('multistep background fields (parity with popup)', () => {
  const step = (n: number) => ({ title: `Шаг ${n}`, body: `Текст ${n}` });
  const multistep = (extra: Record<string, unknown> = {}) =>
    makePromo({ format: 'multistep', steps: [step(1), step(2)], ...extra });

  it('accepts and preserves backgroundColor / backgroundImage / backgroundGradient on multistep', () => {
    // Фон диалога/шторки multistep — те же поля, что у popup (image ⊃ gradient
    // ⊃ color в composeOverlayBackground). Схема не гейтит их по формату, так
    // что multistep-промо с фоном парсится и поля доезжают до storefront.
    const parsed = promoSchema.parse(
      multistep({
        backgroundColor: '#123456',
        backgroundImage: 'https://cdn.example.com/bg.png',
        backgroundGradient: { from: '#ff0000', to: '#0000ff', angle: 90 },
      }),
    );
    expect(parsed.backgroundColor).toBe('#123456');
    expect(parsed.backgroundImage).toBe('https://cdn.example.com/bg.png');
    expect(parsed.backgroundGradient).toEqual({ from: '#ff0000', to: '#0000ff', angle: 90 });
  });

  it('accepts a multistep promo with only backgroundGradient (from-only)', () => {
    const parsed = promoSchema.parse(multistep({ backgroundGradient: { from: '#E11D2A' } }));
    expect(parsed.backgroundGradient).toEqual({ from: '#E11D2A' });
  });
});

describe('multistep presentation (modal | fullscreen)', () => {
  const step = (n: number) => ({ title: `Шаг ${n}`, body: `Текст ${n}` });
  const multistep = () => makePromo({ format: 'multistep', steps: [step(1), step(2)] });

  it('accepts modal and fullscreen on a multistep promo', () => {
    expect(promoSchema.parse({ ...multistep(), presentation: 'modal' }).presentation).toBe('modal');
    expect(promoSchema.parse({ ...multistep(), presentation: 'fullscreen' }).presentation).toBe('fullscreen');
  });

  it('is optional (omitted = renderer default modal)', () => {
    expect(promoSchema.parse(multistep()).presentation).toBeUndefined();
  });

  it('rejects unknown presentation values', () => {
    expect(() => promoSchema.parse({ ...multistep(), presentation: 'sheet' })).toThrow();
  });

  it('rejects presentation on non-multistep formats (refine, mirrors the cabinet)', () => {
    expect(() => promoSchema.parse(makePromo({ presentation: 'fullscreen' }))).toThrow();
    expect(() => promoSchema.parse(makePromo({ presentation: 'modal' }))).toThrow();
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
  'custom',
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
