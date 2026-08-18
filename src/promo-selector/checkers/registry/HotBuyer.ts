import { Checker, type CheckContext } from '../Checker';
import type { Promo } from '../../types';

const DEFAULT_MIN_PHONE_VIEWS = 2;

export function hasHotBuyerRule(promo: Promo): boolean {
  return promo.targeting.behavior?.hotBuyer !== undefined;
}

/** Gates promos by "opened seller phones of N distinct listings in the last 7 days". */
export class HotBuyerChecker extends Checker {
  readonly name = 'hot-buyer';

  expect() {
    return 'viewer opened enough distinct seller phones in the last 7 days';
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasHotBuyerRule(ctx.promo) ? false : 'no hot-buyer targeting';
  }

  check(ctx: CheckContext): boolean {
    const min = ctx.promo.targeting.behavior?.hotBuyer?.minPhoneViews ?? DEFAULT_MIN_PHONE_VIEWS;
    // Рукописный minPhoneViews: 0 — невалидное правило, не «пропустить всех».
    if (!Number.isInteger(min) || min < 1) return false;
    if (!ctx.behavior) return false; // fail closed
    return ctx.behavior.phoneViews7d >= min;
  }
}
