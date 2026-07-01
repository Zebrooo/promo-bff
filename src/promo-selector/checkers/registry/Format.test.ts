import { describe, expect, it } from 'vitest';
import { FormatChecker } from './Format';
import { makeCheckContext, makePromo } from '../../../test-utils';

describe('FormatChecker', () => {
  const checker = new FormatChecker();

  it('is a no-op (eligible) when the request carries no formats', async () => {
    const ctx = makeCheckContext({ promo: makePromo({ format: 'topline' }) });
    expect(checker.shouldSkip(ctx)).toBeTruthy();
    expect(await checker.run(ctx, {} as never)).toBe(true);
  });

  it('is a no-op when formats is an empty array', async () => {
    const ctx = makeCheckContext({ promo: makePromo({ format: 'topline' }), formats: [] });
    expect(checker.shouldSkip(ctx)).toBeTruthy();
    expect(await checker.run(ctx, {} as never)).toBe(true);
  });

  it('passes a promo whose format is in the accepted set', () => {
    const ctx = makeCheckContext({ promo: makePromo({ format: 'popup' }), formats: ['popup', 'fullscreen'] });
    expect(checker.shouldSkip(ctx)).toBe(false);
    expect(checker.check(ctx)).toBe(true);
  });

  it('rejects a promo whose format is not in the accepted set', () => {
    const ctx = makeCheckContext({ promo: makePromo({ format: 'topline' }), formats: ['popup', 'fullscreen'] });
    expect(checker.shouldSkip(ctx)).toBe(false);
    expect(checker.check(ctx)).toBe(false);
  });

  it('gates a single-format surface (topline) exactly', () => {
    const wanted = makeCheckContext({ promo: makePromo({ format: 'topline' }), formats: ['topline'] });
    const other = makeCheckContext({ promo: makePromo({ format: 'tooltip' }), formats: ['topline'] });
    expect(checker.check(wanted)).toBe(true);
    expect(checker.check(other)).toBe(false);
  });
});
