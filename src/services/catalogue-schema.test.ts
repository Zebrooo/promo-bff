import { describe, expect, it } from 'vitest';
import { catalogueSchema, parsePoolLeniently, promoFormatSchema, promoSchema, queueSchema } from './catalogue-schema';
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

  it('does not strip targeting.listings (regression: silently-dropped-field bug)', () => {
    const promo = makePromo({
      targeting: {
        listings: {
          categories: ['avto'],
          categoriesMatch: 'all',
          activeCategories: ['avto'],
          hasUnpromotedActive: true,
          inactiveDays: 14,
        },
      },
    });
    const result = promoSchema.safeParse(promo);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targeting.listings).toEqual({
        categories: ['avto'],
        categoriesMatch: 'all',
        activeCategories: ['avto'],
        hasUnpromotedActive: true,
        inactiveDays: 14,
      });
    }
  });

  it('rejects an out-of-range inactiveDays', () => {
    const promo = makePromo({ targeting: { listings: { inactiveDays: -1 } } });
    expect(promoSchema.safeParse(promo).success).toBe(false);
  });
});

describe('purchases/balance targeting (regression: must not be stripped by z.object)', () => {
  // Bug: targeting was a plain z.object({...}) without `purchases`/`balance`
  // keys, so zod's default strip behaviour silently dropped these fields
  // before PurchaseChecker/BalanceChecker ever saw them — the checkers would
  // always see `undefined` and always shouldSkip(). This locks in the fix.
  it('preserves targeting.purchases through promoSchema.safeParse', () => {
    const purchases = { purchased: true, minTotalKopecks: 50000 };
    const result = promoSchema.safeParse(makePromo({ targeting: { purchases } }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targeting.purchases).toEqual(purchases);
    }
  });

  it('preserves targeting.balance through promoSchema.safeParse', () => {
    const balance = { currentAbove: 10000, movementLookbackDays: 30 };
    const result = promoSchema.safeParse(makePromo({ targeting: { balance } }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.targeting.balance).toEqual(balance);
    }
  });

  it('preserves targeting.purchases and targeting.balance through parsePoolLeniently', () => {
    const purchases = { purchased: true, minTotalKopecks: 50000 };
    const balance = { currentAbove: 10000, movementLookbackDays: 30 };
    const { promos, rejected } = parsePoolLeniently([
      makePromo({ targeting: { purchases, balance } }),
    ]);
    expect(rejected).toEqual([]);
    expect(promos).toHaveLength(1);
    expect(promos[0].targeting.purchases).toEqual(purchases);
    expect(promos[0].targeting.balance).toEqual(balance);
  });

  it('rejects an unknown pack type in targeting.purchases.packTypes', () => {
    const parsePurchases = (purchases: Record<string, unknown>) =>
      promoSchema.safeParse(makePromo({ targeting: { purchases } as never }));

    expect(parsePurchases({ packTypes: ['gold'] }).success).toBe(false);
    expect(parsePurchases({ packTypes: ['bump', 'premium', 'vip'] }).success).toBe(true);
  });

  it('rejects an out-of-range lookbackDays in targeting.purchases', () => {
    const parsePurchases = (purchases: Record<string, unknown>) =>
      promoSchema.safeParse(makePromo({ targeting: { purchases } as never }));

    expect(parsePurchases({ lookbackDays: 0 }).success).toBe(false);
    expect(parsePurchases({ lookbackDays: 366 }).success).toBe(false);
    expect(parsePurchases({ lookbackDays: 1.5 }).success).toBe(false);
    expect(parsePurchases({ lookbackDays: 365 }).success).toBe(true);
  });

  it('rejects an out-of-range movementLookbackDays in targeting.balance', () => {
    const parseBalance = (balance: Record<string, unknown>) =>
      promoSchema.safeParse(makePromo({ targeting: { balance } as never }));

    expect(parseBalance({ movementLookbackDays: 0 }).success).toBe(false);
    expect(parseBalance({ movementLookbackDays: 366 }).success).toBe(false);
    expect(parseBalance({ movementLookbackDays: 365 }).success).toBe(true);
  });

  it('rejects an unknown pack type via parsePoolLeniently (item dropped, not the whole pool)', () => {
    const good = makePromo({ id: 'good' });
    const bad = makePromo({ id: 'bad', targeting: { purchases: { packTypes: ['gold'] } } as never });
    const { promos, rejected } = parsePoolLeniently([good, bad]);
    expect(promos.map((p) => p.id)).toEqual(['good']);
    expect(rejected.map((r) => r.promoId)).toEqual(['bad']);
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

describe('promoSchema — env-таргетинг (os/environments/deviceBrands)', () => {
  const baseEnvPromo = {
    id: 'env-p', name: 'Env', startsAt: '2024-01-01T00:00:00.000Z', endsAt: '2024-12-31T00:00:00.000Z',
    targeting: {}, cooldownHours: 0, format: 'inline', title: 'T',
  };

  it('парсит промо с тремя новыми полями и round-trip’ит значения', () => {
    const parsed = promoSchema.parse({
      ...baseEnvPromo,
      targeting: { os: ['ios'], environments: ['telegram', 'pwa'], deviceBrands: ['iphone', 'android-flagship'] },
    });
    expect(parsed.targeting).toEqual({
      os: ['ios'], environments: ['telegram', 'pwa'], deviceBrands: ['iphone', 'android-flagship'],
    });
  });

  it('промо без новых полей валидно (бит-в-бит старое поведение)', () => {
    const parsed = promoSchema.parse(baseEnvPromo);
    expect(parsed.targeting.os).toBeUndefined();
    expect(parsed.targeting.environments).toBeUndefined();
    expect(parsed.targeting.deviceBrands).toBeUndefined();
  });

  it('опечатка в enum отбрасывает только этот промо (parsePoolLeniently)', () => {
    const broken = { ...baseEnvPromo, id: 'broken', targeting: { os: ['windows'] } };
    const { promos, rejected } = parsePoolLeniently([broken, baseEnvPromo]);
    expect(promos.map((p) => p.id)).toEqual(['env-p']);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].promoId).toBe('broken');
  });
});

describe('promoSchema — targeting geo fields (IP-geo, WS-2)', () => {
  it('parses geoSegments + geoCities and round-trips them', () => {
    const parsed = promoSchema.parse(makePromo({
      targeting: { geoSegments: ['local', 'tourist'], geoCities: ['sukhum', 'sochi'] } as never,
    }));
    expect(parsed.targeting.geoSegments).toEqual(['local', 'tourist']);
    expect(parsed.targeting.geoCities).toEqual(['sukhum', 'sochi']);
  });

  it('rejects an unknown segment and an empty/oversized city slug', () => {
    expect(promoSchema.safeParse(makePromo({ targeting: { geoSegments: ['moon'] } as never })).success).toBe(false);
    expect(promoSchema.safeParse(makePromo({ targeting: { geoCities: [''] } as never })).success).toBe(false);
    expect(promoSchema.safeParse(makePromo({ targeting: { geoCities: ['x'.repeat(65)] } as never })).success).toBe(false);
  });

  it('old JSON without geo fields parses byte-for-byte as before (regression)', () => {
    const parsed = promoSchema.parse(makePromo());
    expect(parsed.targeting).not.toHaveProperty('geoSegments');
    expect(parsed.targeting).not.toHaveProperty('geoCities');
  });
});

describe('promoSchema — schedule (dayparting, WS-3)', () => {
  const valid = { daysOfWeek: [1, 2, 3, 4, 5], hourStart: 9, hourEnd: 18 };

  it('parses and keeps a valid schedule', () => {
    const parsed = promoSchema.parse(makePromo({ schedule: valid } as never));
    expect(parsed.schedule).toEqual(valid);
  });

  it('a promo without schedule still parses (back-compat)', () => {
    expect(promoSchema.parse(makePromo()).schedule).toBeUndefined();
  });

  it('broken schedule is dropped to undefined, promo survives (fail-open, not rejected)', () => {
    const broken = [
      { daysOfWeek: [], hourStart: 0, hourEnd: 24 },     // пустые дни
      { daysOfWeek: [1], hourStart: 9, hourEnd: 25 },    // 25-й час
      { daysOfWeek: [1], hourStart: 18, hourEnd: 9 },    // start >= end
      { daysOfWeek: [1, 1], hourStart: 9, hourEnd: 18 }, // дубли
      'will-fix-later',                                  // не объект
    ];
    for (const schedule of broken) {
      const { promos, rejected } = parsePoolLeniently([makePromo({ schedule: schedule as never })]);
      expect(rejected).toEqual([]);
      expect(promos).toHaveLength(1);
      expect(promos[0].schedule).toBeUndefined();
    }
  });
});

describe('promoSchema — visit-profile targeting fields (WS-4)', () => {
  it('accepts visitorClass with thresholds and entrySources', () => {
    const promo = makePromo({
      targeting: { visitorClass: 'newcomer', newcomerMaxAgeDays: 14 } as never,
      entrySources: ['telegram', 'search'] as never,
    });
    const res = promoSchema.safeParse(promo);
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.targeting.visitorClass).toBe('newcomer');
      expect(res.data.targeting.newcomerMaxAgeDays).toBe(14);
      expect(res.data.entrySources).toEqual(['telegram', 'search']);
    }
  });

  it('old promos without the new fields still parse (back-compat)', () => {
    const res = promoSchema.safeParse(makePromo());
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.entrySources).toBeUndefined();
      expect(res.data.targeting.visitorClass).toBeUndefined();
    }
  });

  it('rejects out-of-range thresholds and unknown source classes', () => {
    expect(promoSchema.safeParse(makePromo({ targeting: { visitorClass: 'newcomer', newcomerMaxAgeDays: 0 } as never })).success).toBe(false);
    expect(promoSchema.safeParse(makePromo({ targeting: { visitorClass: 'regular', regularMinVisitDays: 31 } as never })).success).toBe(false);
    expect(promoSchema.safeParse(makePromo({ targeting: { visitorClass: 'vip' } as never })).success).toBe(false);
    expect(promoSchema.safeParse(makePromo({ entrySources: ['vk'] } as never)).success).toBe(false);
  });

  it('accepts an empty entrySources array (lenient pool must not drop the promo)', () => {
    expect(promoSchema.safeParse(makePromo({ entrySources: [] } as never)).success).toBe(true);
  });
});

describe('promoSchema — behavior targeting (wave B)', () => {
  it('parses a full behavior block and keeps it on the promo', () => {
    const behavior = {
      interest: { categories: ['shiny', 'diski'], lookbackDays: 7 },
      hotBuyer: { minPhoneViews: 2 },
      minSessionViews: 5,
    };
    const parsed = promoSchema.parse(makePromo({ targeting: { behavior } }));
    expect(parsed.targeting.behavior).toEqual(behavior);
  });

  it('promo WITHOUT behavior parses byte-for-byte as before (обратная совместимость)', () => {
    const parsed = promoSchema.parse(makePromo());
    expect(parsed.targeting).not.toHaveProperty('behavior');
  });

  it('rejects out-of-range values (lookbackDays 0/15, minPhoneViews 0/51, minSessionViews 0/101, >20 категорий, пустой slug)', () => {
    const bad = (behavior: unknown) =>
      promoSchema.safeParse(makePromo({ targeting: { behavior } as never })).success;
    expect(bad({ interest: { categories: ['shiny'], lookbackDays: 0 } })).toBe(false);
    expect(bad({ interest: { categories: ['shiny'], lookbackDays: 15 } })).toBe(false);
    expect(bad({ interest: { categories: [''] } })).toBe(false);
    expect(bad({ interest: { categories: ['x'.repeat(65)] } })).toBe(false);
    expect(bad({ interest: { categories: [] } })).toBe(false);
    expect(bad({ interest: { categories: Array.from({ length: 21 }, (_, i) => `c${i}`) } })).toBe(false);
    expect(bad({ hotBuyer: { minPhoneViews: 0 } })).toBe(false);
    expect(bad({ hotBuyer: { minPhoneViews: 51 } })).toBe(false);
    expect(bad({ minSessionViews: 0 })).toBe(false);
    expect(bad({ minSessionViews: 101 })).toBe(false);
  });

  it('accepts boundary values (1/14, 1/50, 1/100, 20 категорий)', () => {
    const ok = (behavior: unknown) =>
      promoSchema.safeParse(makePromo({ targeting: { behavior } as never })).success;
    expect(ok({ interest: { categories: ['shiny'], lookbackDays: 1 } })).toBe(true);
    expect(ok({ interest: { categories: Array.from({ length: 20 }, (_, i) => `c${i}`), lookbackDays: 14 } })).toBe(true);
    expect(ok({ hotBuyer: { minPhoneViews: 1 } })).toBe(true);
    expect(ok({ hotBuyer: { minPhoneViews: 50 } })).toBe(true);
    expect(ok({ minSessionViews: 1 })).toBe(true);
    expect(ok({ minSessionViews: 100 })).toBe(true);
  });
});

describe('promoSchema — lifecycle (wave B)', () => {
  it('accepts a valid lifecycle block', () => {
    const parsed = promoSchema.parse(makePromo({
      lifecycle: {
        activeInCategories: ['avto'], soldWithinDays: 14,
        hasStalledActive: true, firstListingWithinDays: 7,
      },
    }));
    expect(parsed.lifecycle?.soldWithinDays).toBe(14);
  });

  it('accepts each condition alone and the boundary values (1, 90, 30)', () => {
    expect(() => promoSchema.parse(makePromo({ lifecycle: { soldWithinDays: 1 } }))).not.toThrow();
    expect(() => promoSchema.parse(makePromo({ lifecycle: { soldWithinDays: 90 } }))).not.toThrow();
    expect(() => promoSchema.parse(makePromo({ lifecycle: { firstListingWithinDays: 30 } }))).not.toThrow();
    expect(() => promoSchema.parse(makePromo({ lifecycle: { hasStalledActive: true } }))).not.toThrow();
  });

  it('rejects an empty lifecycle object and an all-undefined one (Formik-стейт кабинета)', () => {
    expect(() => promoSchema.parse(makePromo({ lifecycle: {} }))).toThrow();
    expect(() => promoSchema.parse(makePromo({ lifecycle: { soldWithinDays: undefined } }))).toThrow();
  });

  it('rejects out-of-range days (0, 91, 31)', () => {
    expect(() => promoSchema.parse(makePromo({ lifecycle: { soldWithinDays: 0 } }))).toThrow();
    expect(() => promoSchema.parse(makePromo({ lifecycle: { soldWithinDays: 91 } }))).toThrow();
    expect(() => promoSchema.parse(makePromo({ lifecycle: { firstListingWithinDays: 31 } }))).toThrow();
  });

  it('rejects hasStalledActive: false (literal true only) and an empty categories list', () => {
    expect(() => promoSchema.parse(makePromo({ lifecycle: { hasStalledActive: false as never } }))).toThrow();
    expect(() => promoSchema.parse(makePromo({ lifecycle: { activeInCategories: [] } }))).toThrow();
  });

  it('back-compat: a promo without lifecycle stays valid', () => {
    expect(() => promoSchema.parse(makePromo())).not.toThrow();
    expect(promoSchema.parse(makePromo()).lifecycle).toBeUndefined();
  });
});

describe('promoSchema — лид-режим (leadCapture)', () => {
  it('пропускает leadCapture до чекеров и до рендерера', () => {
    const result = promoSchema.safeParse(makePromo({ leadCapture: true }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.leadCapture).toBe(true);
  });

  it('поле необязательное — промо без него парсится как прежде', () => {
    const result = promoSchema.safeParse(makePromo({}));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.leadCapture).toBeUndefined();
  });

  it('нестрогое значение отвергается (только boolean)', () => {
    expect(promoSchema.safeParse({ ...makePromo(), leadCapture: 'yes' }).success).toBe(false);
  });
});
