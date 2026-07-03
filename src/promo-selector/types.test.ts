import { describe, expect, it } from 'vitest';
import type { PromoFormat, Promo } from './types';

describe('PromoFormat', () => {
  it('includes custom', () => {
    const format: PromoFormat = 'custom';
    expect(format).toBe('custom');
  });

  it('still includes banner (auction-only creative)', () => {
    const format: PromoFormat = 'banner';
    expect(format).toBe('banner');
  });
});

describe('Promo.variant', () => {
  it('carries an optional variant on a custom-format promo', () => {
    const promo = {
      id: 'c1',
      name: 'Custom',
      startsAt: '2020-01-01T00:00:00.000Z',
      endsAt: '2100-01-01T00:00:00.000Z',
      targeting: {},
      cooldownHours: 0,
      format: 'custom' as const,
      title: 'Custom',
      variant: 'reklama-onboarding',
    } satisfies Promo;
    expect(promo.variant).toBe('reklama-onboarding');
  });
});
