import { describe, expect, it } from 'vitest';
import { EnvChecker } from './Env';
import { makeCheckContext, makePromo } from '../../../test-utils';

const c = new EnvChecker();

describe('EnvChecker', () => {
  it('skips (eligible) when the promo has no env targeting rules', () => {
    expect(c.shouldSkip(makeCheckContext())).toBe('no env targeting rules');
    expect(c.shouldSkip(makeCheckContext({
      promo: makePromo({ targeting: { os: [], environments: [], deviceBrands: [] } }),
    }))).toBe('no env targeting rules');
  });

  it('runs when any axis has rules', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ targeting: { os: ['ios'] } }) }))).toBe(false);
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ targeting: { environments: ['telegram'] } }) }))).toBe(false);
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ targeting: { deviceBrands: ['iphone'] } }) }))).toBe(false);
  });

  describe('os axis (fail-closed)', () => {
    const promo = makePromo({ targeting: { os: ['ios'] } });
    it('passes on a matching os', () => {
      expect(c.check(makeCheckContext({ promo, env: { os: 'ios' } }))).toBe(true);
    });
    it('fails on a different os', () => {
      expect(c.check(makeCheckContext({ promo, env: { os: 'android' } }))).toBe(false);
    });
    it('fails when the os signal is missing (десктоп/нераспознанное)', () => {
      expect(c.check(makeCheckContext({ promo }))).toBe(false);
      expect(c.check(makeCheckContext({ promo, env: { runtime: 'browser' } }))).toBe(false);
    });
  });

  describe('environments axis (fail-closed)', () => {
    const promo = makePromo({ targeting: { environments: ['telegram', 'pwa'] } });
    it('passes on telegram', () => {
      expect(c.check(makeCheckContext({ promo, env: { runtime: 'telegram' } }))).toBe(true);
    });
    it('fails on browser', () => {
      expect(c.check(makeCheckContext({ promo, env: { runtime: 'browser' } }))).toBe(false);
    });
    it('fails when runtime is missing', () => {
      expect(c.check(makeCheckContext({ promo, env: { os: 'ios' } }))).toBe(false);
    });
  });

  describe('deviceBrands axis (fail-closed)', () => {
    const promo = makePromo({ targeting: { deviceBrands: ['android-flagship'] } });
    it('passes on android-flagship', () => {
      expect(c.check(makeCheckContext({ promo, env: { brand: 'android-flagship' } }))).toBe(true);
    });
    it('fails on android-other', () => {
      expect(c.check(makeCheckContext({ promo, env: { brand: 'android-other' } }))).toBe(false);
    });
    it('fails when brand is missing', () => {
      expect(c.check(makeCheckContext({ promo, env: { os: 'android' } }))).toBe(false);
    });
  });

  it('axes combine as AND: os matches but environments does not → fail', () => {
    const promo = makePromo({ targeting: { os: ['android'], environments: ['app'] } });
    expect(c.check(makeCheckContext({ promo, env: { os: 'android', runtime: 'browser' } }))).toBe(false);
    expect(c.check(makeCheckContext({ promo, env: { os: 'android', runtime: 'app' } }))).toBe(true);
  });
});
