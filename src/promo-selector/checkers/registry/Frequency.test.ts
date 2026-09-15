import { describe, expect, it } from 'vitest';
import { CooldownPromosChecker, CooldownSelfChecker, LimitChecker } from './Frequency';
import { makeCheckContext, makePromo, makeSuppliers } from '../../../test-utils';

describe('LimitChecker', () => {
  const c = new LimitChecker();
  it('skips when no cap is configured', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ id: 'p' }) }))).toBeTruthy();
  });
  it('passes under the cap, fails at the cap', () => {
    const ctx = makeCheckContext({ promo: makePromo({ id: 'p', maxImpressionsPerUser: 3 }) });
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { p: 2 } }))).toBe(true);
    expect(c.check(ctx, makeSuppliers({ impressionCounts: { p: 3 } }))).toBe(false);
  });
});

describe('CooldownSelfChecker (общая пауза формата)', () => {
  const c = new CooldownSelfChecker();
  const now = new Date('2024-06-01T12:00:00.000Z');
  const source = makePromo({ id: 'source', format: 'popup', cooldownSelfMinutes: 120 });
  const candidate = makePromo({ id: 'candidate', format: 'popup' });
  const pool = new Map([[source.id, source], [candidate.id, candidate]]);
  const shownHourAgo = { lastShownAt: { source: '2024-06-01T11:00:00.000Z' } };

  it('пропускается без пула — источники пауз неизвестны', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: candidate }))).toBeTruthy();
    expect(c.shouldSkip(makeCheckContext({ promo: candidate, pool }))).toBe(false);
  });
  it('блокирует другое промо того же формата, пока пауза источника не истекла', () => {
    expect(c.check(makeCheckContext({ promo: candidate, pool, now }), makeSuppliers(shownHourAgo))).toBe(false);
  });
  it('пропускает после истечения паузы (ровно на границе — тоже)', () => {
    expect(c.check(makeCheckContext({ promo: candidate, pool, now }),
      makeSuppliers({ lastShownAt: { source: '2024-06-01T10:00:00.000Z' } }))).toBe(true);
  });
  it('сам источник под свою паузу не попадает', () => {
    expect(c.check(makeCheckContext({ promo: source, pool, now }), makeSuppliers(shownHourAgo))).toBe(true);
  });
  it('другой формат не блокируется', () => {
    const fullscreen = makePromo({ id: 'fs', format: 'fullscreen' });
    expect(c.check(makeCheckContext({ promo: fullscreen, pool, now }), makeSuppliers(shownHourAgo))).toBe(true);
  });
  it('другое устройство не блокируется; неизвестное устройство с любой стороны — блокируется', () => {
    const touchShow = { ...shownHourAgo, lastDevice: { source: 'touch' } };
    expect(c.check(makeCheckContext({ promo: candidate, pool, now, device: 'desktop' }), makeSuppliers(touchShow))).toBe(true);
    expect(c.check(makeCheckContext({ promo: candidate, pool, now, device: 'touch' }), makeSuppliers(touchShow))).toBe(false);
    expect(c.check(makeCheckContext({ promo: candidate, pool, now }), makeSuppliers(touchShow))).toBe(false);
    expect(c.check(makeCheckContext({ promo: candidate, pool, now, device: 'desktop' }), makeSuppliers(shownHourAgo))).toBe(false);
  });
  it('источник без паузы, удалённый из пула или с битой датой не блокирует', () => {
    const noPause = new Map([['source', makePromo({ id: 'source', format: 'popup' })], [candidate.id, candidate]]);
    expect(c.check(makeCheckContext({ promo: candidate, pool: noPause, now }), makeSuppliers(shownHourAgo))).toBe(true);
    expect(c.check(makeCheckContext({ promo: candidate, pool: new Map([[candidate.id, candidate]]), now }), makeSuppliers(shownHourAgo))).toBe(true);
    expect(c.check(makeCheckContext({ promo: candidate, pool, now }), makeSuppliers({ lastShownAt: { source: 'not-a-date' } }))).toBe(true);
  });
  it('устаревшее cooldownHours источника считается паузой формата', () => {
    const legacy = makePromo({ id: 'source', format: 'popup', cooldownHours: 2 });
    const legacyPool = new Map([[legacy.id, legacy], [candidate.id, candidate]]);
    expect(c.check(makeCheckContext({ promo: candidate, pool: legacyPool, now }), makeSuppliers(shownHourAgo))).toBe(false);
  });
});

describe('CooldownPromosChecker (направленные паузы)', () => {
  const c = new CooldownPromosChecker();
  const now = new Date('2024-06-01T12:00:00.000Z');
  it('пропускается без правил', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ cooldownPromos: [] }) }))).toBeTruthy();
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({ cooldownPromos: [{ promoId: 'a', minutes: 1 }] }) }))).toBe(false);
  });
  it('блокирует, пока не истекло хотя бы одно правило; ссылка на себя работает', () => {
    const self = makePromo({ id: 'p', cooldownPromos: [{ promoId: 'p', minutes: 3 }] });
    expect(c.check(makeCheckContext({ promo: self, now }), makeSuppliers({ lastShownAt: { p: '2024-06-01T11:58:00.000Z' } }))).toBe(false);
    expect(c.check(makeCheckContext({ promo: self, now }), makeSuppliers({ lastShownAt: { p: '2024-06-01T11:57:00.000Z' } }))).toBe(true);
    const two = makePromo({ id: 'b', cooldownPromos: [{ promoId: 'a', minutes: 60 }, { promoId: 'c', minutes: 60 }] });
    expect(c.check(makeCheckContext({ promo: two, now }), makeSuppliers({
      lastShownAt: { a: '2024-06-01T09:00:00.000Z', c: '2024-06-01T11:30:00.000Z' },
    }))).toBe(false);
  });
  it('правило без показа и битая дата не блокируют; устройство не учитывается', () => {
    const rule = makePromo({ id: 'b', cooldownPromos: [{ promoId: 'a', minutes: 60 }] });
    expect(c.check(makeCheckContext({ promo: rule, now }), makeSuppliers({ lastShownAt: {} }))).toBe(true);
    expect(c.check(makeCheckContext({ promo: rule, now }), makeSuppliers({ lastShownAt: { a: 'nope' } }))).toBe(true);
    expect(c.check(makeCheckContext({ promo: rule, now, device: 'desktop' }),
      makeSuppliers({ lastShownAt: { a: '2024-06-01T11:30:00.000Z' }, lastDevice: { a: 'touch' } }))).toBe(false);
  });
  it('устаревшее cooldownHours кандидата = правило на себя', () => {
    const legacy = makePromo({ id: 'p', cooldownHours: 24 });
    expect(c.check(makeCheckContext({ promo: legacy, now }), makeSuppliers({ lastShownAt: { p: '2024-06-01T11:00:00.000Z' } }))).toBe(false);
    expect(c.check(makeCheckContext({ promo: legacy, now }), makeSuppliers({ lastShownAt: { other: '2024-06-01T11:00:00.000Z' } }))).toBe(true);
  });
});
