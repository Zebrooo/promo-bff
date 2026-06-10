import { Checker, type CheckContext } from '../Checker';

/** A promo may only be shown within its [startsAt, endsAt] window. */
export class DateChecker extends Checker {
  readonly name = 'date';
  expect() { return 'now is within [startsAt, endsAt]'; }
  check(ctx: CheckContext): boolean {
    const now = ctx.now.getTime();
    const start = new Date(ctx.promo.startsAt).getTime();
    const end = new Date(ctx.promo.endsAt).getTime();
    if (Number.isNaN(start) || Number.isNaN(end)) return false;
    return now >= start && now <= end;
  }
}
