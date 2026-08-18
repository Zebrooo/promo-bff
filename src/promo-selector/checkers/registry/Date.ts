import { Checker, type CheckContext } from '../Checker';
import type { PromoSchedule } from '../../types';

/** Москва живёт на постоянном UTC+3 (без переходов с 2014); Сухум — на
 *  московском времени. Одна константа — единственная правка, если закон
 *  вернёт сезонный сдвиг (спека targeting-schedule §8). */
const MSK_OFFSET_MS = 3 * 60 * 60 * 1000;

/** Защитная перепроверка на случай путей мимо схемы (спека §6): невалидное
 *  расписание молча игнорируется (fail-open — промо ведёт себя как без него). */
function isValidSchedule(s: unknown): s is PromoSchedule {
  if (typeof s !== 'object' || s === null) return false;
  const o = s as Record<string, unknown>;
  const { daysOfWeek, hourStart, hourEnd } = o;
  return Array.isArray(daysOfWeek)
    && daysOfWeek.length > 0
    && daysOfWeek.every((d) => Number.isInteger(d) && (d as number) >= 1 && (d as number) <= 7)
    && Number.isInteger(hourStart) && (hourStart as number) >= 0 && (hourStart as number) <= 23
    && Number.isInteger(hourEnd) && (hourEnd as number) >= 1 && (hourEnd as number) <= 24
    && (hourStart as number) < (hourEnd as number);
}

/** A promo may only be shown within its [startsAt, endsAt] window; when a
 *  valid `schedule` is present — additionally only on its MSK days/hours. */
export class DateChecker extends Checker {
  readonly name = 'date';
  expect() { return 'now is within [startsAt, endsAt] and MSK time matches schedule'; }
  check(ctx: CheckContext): boolean {
    const now = ctx.now.getTime();
    const start = new Date(ctx.promo.startsAt).getTime();
    const end = new Date(ctx.promo.endsAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    if (now < start || now > end) return false;
    const s = ctx.promo.schedule;
    if (!isValidSchedule(s)) return true; // нет/мусор → как раньше (fail-open)
    const msk = new Date(now + MSK_OFFSET_MS);
    const isoDay = msk.getUTCDay() === 0 ? 7 : msk.getUTCDay(); // 1=Пн..7=Вс
    const hour = msk.getUTCHours();
    return s.daysOfWeek.includes(isoDay) && hour >= s.hourStart && hour < s.hourEnd;
  }
}
