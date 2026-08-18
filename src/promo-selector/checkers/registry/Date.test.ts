import { describe, expect, it } from 'vitest';
import { DateChecker } from './Date';
import { makeCheckContext, makePromo } from '../../../test-utils';

const c = new DateChecker();

describe('DateChecker', () => {
  it('passes inside the window', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2100-01-01T00:00:00.000Z' }),
      now: new Date('2024-06-01T12:00:00.000Z'),
    });
    expect(c.check(ctx)).toBe(true);
  });
  it('fails before the start', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: '2100-01-01T00:00:00.000Z', endsAt: '2200-01-01T00:00:00.000Z' }),
    });
    expect(c.check(ctx)).toBe(false);
  });
  it('fails after the end', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: '2000-01-01T00:00:00.000Z', endsAt: '2001-01-01T00:00:00.000Z' }),
    });
    expect(c.check(ctx)).toBe(false);
  });
  it('fails on an unparseable date range', () => {
    const ctx = makeCheckContext({
      promo: makePromo({ startsAt: 'not-a-date', endsAt: 'also-not-a-date' }),
    });
    expect(c.check(ctx)).toBe(false);
  });
});

describe('DateChecker — dayparting (schedule, МСК = UTC+3)', () => {
  const window = { startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2100-01-01T00:00:00.000Z' };
  const weekdays9to18 = { daysOfWeek: [1, 2, 3, 4, 5], hourStart: 9, hourEnd: 18 };
  const at = (nowIso: string, schedule?: unknown) => makeCheckContext({
    promo: makePromo({ ...window, schedule: schedule as never }),
    now: new Date(nowIso),
  });

  it('schedule отсутствует → поведение идентично текущему (pass в окне)', () => {
    expect(c.check(at('2026-08-17T12:00:00.000Z'))).toBe(true);
  });

  it('будни 9–18: пн 06:00Z (= 09:00 МСК) → pass (нижняя граница включительно)', () => {
    expect(c.check(at('2026-08-17T06:00:00.000Z', weekdays9to18))).toBe(true);
  });

  it('будни 9–18: пн 15:00Z (= 18:00 МСК) → fail (hourEnd исключающий); 14:59Z → pass', () => {
    expect(c.check(at('2026-08-17T15:00:00.000Z', weekdays9to18))).toBe(false);
    expect(c.check(at('2026-08-17T14:59:00.000Z', weekdays9to18))).toBe(true);
  });

  it('hourEnd 24: 23:59 МСК → pass; 00:00 МСК уже СЛЕДУЮЩИЙ день недели', () => {
    const mondayOnlyAllDay = { daysOfWeek: [1], hourStart: 0, hourEnd: 24 };
    // пн 20:59Z = пн 23:59 МСК → pass
    expect(c.check(at('2026-08-17T20:59:00.000Z', mondayOnlyAllDay))).toBe(true);
    // пн 21:00Z = вт 00:00 МСК → вторник не в daysOfWeek → fail
    expect(c.check(at('2026-08-17T21:00:00.000Z', mondayOnlyAllDay))).toBe(false);
  });

  it('смена дня недели на границе МСК-суток: вс 21:30Z = ПН 00:30 МСК', () => {
    const weekendsAllDay = { daysOfWeek: [6, 7], hourStart: 0, hourEnd: 24 };
    const weekdaysAllDay = { daysOfWeek: [1, 2, 3, 4, 5], hourStart: 0, hourEnd: 24 };
    expect(c.check(at('2026-08-16T21:30:00.000Z', weekendsAllDay))).toBe(false);
    expect(c.check(at('2026-08-16T21:30:00.000Z', weekdaysAllDay))).toBe(true);
  });

  it('ISO-нумерация: daysOfWeek [7] в вс 12:00 МСК → pass (getUTCDay()===0 → 7)', () => {
    // вс 2026-08-16 09:00Z = вс 12:00 МСК
    expect(c.check(at('2026-08-16T09:00:00.000Z', { daysOfWeek: [7], hourStart: 0, hourEnd: 24 }))).toBe(true);
  });

  it('мусор в schedule → fail-open: pass внутри окна дат', () => {
    const now = '2026-08-17T12:00:00.000Z';
    expect(c.check(at(now, { daysOfWeek: [], hourStart: 0, hourEnd: 24 }))).toBe(true);
    expect(c.check(at(now, { daysOfWeek: [1], hourStart: 18, hourEnd: 9 }))).toBe(true);
    expect(c.check(at(now, { daysOfWeek: [1], hourStart: '9', hourEnd: 18 }))).toBe(true);
    expect(c.check(at(now, 'will-fix-later'))).toBe(true);
  });

  it('окно дат главнее: now вне startsAt/endsAt, но внутри расписания → fail', () => {
    const ctx = makeCheckContext({
      promo: makePromo({
        startsAt: '2000-01-01T00:00:00.000Z',
        endsAt: '2001-01-01T00:00:00.000Z',
        schedule: { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], hourStart: 0, hourEnd: 24 } as never,
      }),
      now: new Date('2026-08-17T12:00:00.000Z'),
    });
    expect(c.check(ctx)).toBe(false);
  });
});
