import { describe, expect, it } from 'vitest';
import { DeviceChecker } from './Device';
import { makeCheckContext, makePromo } from '../../../test-utils';

const c = new DeviceChecker();

describe('DeviceChecker', () => {
  it('skips entirely when the request carries no device (back-compat)', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ deviceTarget: 'desktop' }) }))).toBeTruthy();
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ format: 'tooltip' }) }))).toBeTruthy();
  });

  it('runs (does not skip) once a device is known', () => {
    expect(c.shouldSkip(makeCheckContext({ device: 'touch', promo: makePromo({}) }))).toBe(false);
  });

  describe('deviceTarget gate', () => {
    it('passes when deviceTarget is omitted or "both"', () => {
      expect(c.check(makeCheckContext({ device: 'touch', promo: makePromo({}) }))).toBe(true);
      expect(c.check(makeCheckContext({ device: 'touch', promo: makePromo({ deviceTarget: 'both' }) }))).toBe(true);
    });
    it('passes only on the matching device', () => {
      const desktopOnly = makePromo({ deviceTarget: 'desktop' });
      expect(c.check(makeCheckContext({ device: 'desktop', promo: desktopOnly }))).toBe(true);
      expect(c.check(makeCheckContext({ device: 'touch', promo: desktopOnly }))).toBe(false);
      const touchOnly = makePromo({ deviceTarget: 'touch' });
      expect(c.check(makeCheckContext({ device: 'touch', promo: touchOnly }))).toBe(true);
      expect(c.check(makeCheckContext({ device: 'desktop', promo: touchOnly }))).toBe(false);
    });
  });

  describe('format capability gate', () => {
    it('drops desktop-only formats (topline/tooltip) on touch', () => {
      expect(c.check(makeCheckContext({ device: 'touch', promo: makePromo({ format: 'topline' }) }))).toBe(false);
      expect(c.check(makeCheckContext({ device: 'touch', promo: makePromo({ format: 'tooltip', anchor: 'a1' }) }))).toBe(false);
    });
    it('allows desktop-only formats on desktop', () => {
      expect(c.check(makeCheckContext({ device: 'desktop', promo: makePromo({ format: 'topline' }) }))).toBe(true);
      expect(c.check(makeCheckContext({ device: 'desktop', promo: makePromo({ format: 'tooltip', anchor: 'a1' }) }))).toBe(true);
    });
    it('allows touch-capable formats on touch', () => {
      for (const format of ['inline', 'popup', 'fullscreen', 'divkit'] as const) {
        expect(c.check(makeCheckContext({ device: 'touch', promo: makePromo({ format }) }))).toBe(true);
      }
    });
  });
});
