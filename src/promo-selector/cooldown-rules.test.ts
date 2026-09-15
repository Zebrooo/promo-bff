import { describe, expect, it } from 'vitest';
import { resolveCooldownRules } from './cooldown-rules';
import { makePromo } from '../test-utils';

describe('resolveCooldownRules', () => {
  it('новые поля читаются как есть', () => {
    const rules = resolveCooldownRules(makePromo({
      id: 'p', cooldownSelfMinutes: 90, cooldownPromos: [{ promoId: 'q', minutes: 3 }],
    }));
    expect(rules).toEqual({ selfMinutes: 90, promos: [{ promoId: 'q', minutes: 3 }] });
  });

  it('устаревшее cooldownHours: N > 0 без новых полей = пауза формата N×60 плюс правило на себя N×60', () => {
    expect(resolveCooldownRules(makePromo({ id: 'legacy', cooldownHours: 5 }))).toEqual({
      selfMinutes: 300,
      promos: [{ promoId: 'legacy', minutes: 300 }],
    });
  });

  it('cooldownHours: 0 и отсутствие полей = пауз нет', () => {
    expect(resolveCooldownRules(makePromo({ cooldownHours: 0 }))).toEqual({ selfMinutes: 0, promos: [] });
    expect(resolveCooldownRules(makePromo({ cooldownHours: undefined }))).toEqual({ selfMinutes: 0, promos: [] });
  });

  it('любое новое поле отключает устаревшее', () => {
    expect(resolveCooldownRules(makePromo({ id: 'p', cooldownHours: 5, cooldownSelfMinutes: 0 })))
      .toEqual({ selfMinutes: 0, promos: [] });
    expect(resolveCooldownRules(makePromo({ id: 'p', cooldownHours: 5, cooldownPromos: [{ promoId: 'p', minutes: 3 }] })))
      .toEqual({ selfMinutes: 0, promos: [{ promoId: 'p', minutes: 3 }] });
  });

  it('пустой список правил равен отсутствию поля', () => {
    expect(resolveCooldownRules(makePromo({ id: 'p', cooldownHours: 2, cooldownPromos: [] })))
      .toEqual({ selfMinutes: 120, promos: [{ promoId: 'p', minutes: 120 }] });
  });
});
