import { Checker, type CheckContext } from '../Checker';
import type { Promo } from '../../types';

export function hasBalanceRule(promo: Promo): boolean {
  const rule = promo.targeting.balance;
  if (!rule) return false;
  return (
    rule.currentAbove !== undefined ||
    rule.currentBelow !== undefined ||
    rule.movementAbove !== undefined ||
    rule.movementBelow !== undefined
  );
}

/** Gates promos by the request viewer's wallet balance / recent movement. */
export class BalanceChecker extends Checker {
  readonly name = 'balance';

  expect() {
    return "viewer's wallet balance/movement matches the promo's balance targeting";
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasBalanceRule(ctx.promo) ? false : 'no balance targeting';
  }

  check(ctx: CheckContext): boolean {
    if (!ctx.isAuthorized) return false;
    const rule = ctx.promo.targeting.balance!;
    const current = ctx.walletBalanceKopecks ?? 0;
    const movement = ctx.walletMovementByWindow?.get(rule.movementLookbackDays) ?? 0;

    if (rule.currentAbove !== undefined && current < rule.currentAbove) return false;
    if (rule.currentBelow !== undefined && current > rule.currentBelow) return false;
    if (rule.movementAbove !== undefined && movement < rule.movementAbove) return false;
    if (rule.movementBelow !== undefined && movement > rule.movementBelow) return false;

    return true;
  }
}
