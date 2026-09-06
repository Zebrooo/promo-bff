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

  it("gates the promoline surface: promoline passes, inline does not", () => {
    // Витрина запрашивает промолайн как ['promoline','inline'] (переходный
    // период), но очередь, попросившая только ['promoline'], не должна ловить
    // inline-промо из оверлея.
    const promoline = makeCheckContext({ promo: makePromo({ format: 'promoline' }), formats: ['promoline'] });
    const inline = makeCheckContext({ promo: makePromo({ format: 'inline' }), formats: ['promoline'] });
    expect(checker.shouldSkip(promoline)).toBe(false);
    expect(checker.check(promoline)).toBe(true);
    expect(checker.check(inline)).toBe(false);
  });

  it("accepts both formats the promoline surface asks for (['promoline','inline'])", () => {
    const formats = ['promoline', 'inline'];
    expect(checker.check(makeCheckContext({ promo: makePromo({ format: 'promoline' }), formats }))).toBe(true);
    expect(checker.check(makeCheckContext({ promo: makePromo({ format: 'inline' }), formats }))).toBe(true);
    expect(checker.check(makeCheckContext({ promo: makePromo({ format: 'popup' }), formats }))).toBe(false);
  });

  it('gates a single-format surface (topline) exactly', () => {
    const wanted = makeCheckContext({ promo: makePromo({ format: 'topline' }), formats: ['topline'] });
    const other = makeCheckContext({ promo: makePromo({ format: 'tooltip' }), formats: ['topline'] });
    expect(checker.check(wanted)).toBe(true);
    expect(checker.check(other)).toBe(false);
  });
});
