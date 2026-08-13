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
    const needsCurrent = rule.currentAbove !== undefined || rule.currentBelow !== undefined;
    const needsMovement = rule.movementAbove !== undefined || rule.movementBelow !== undefined;

    // Fail the WHOLE rule closed if data it needs is unavailable (outage), before
    // defaulting anything to 0 — an outage must never let a targeting rule pass
    // for a user whose real value is unknown, even when the OTHER condition (on
    // data that DID load) would have passed on its own.
    if (needsCurrent && ctx.walletBalanceUnavailable) return false;
    if (needsMovement && ctx.walletMovementByWindow?.get(rule.movementLookbackDays) === undefined) return false;

    const current = ctx.walletBalanceKopecks ?? 0;
    const movement = ctx.walletMovementByWindow?.get(rule.movementLookbackDays) ?? 0;

    if (rule.currentAbove !== undefined && current < rule.currentAbove) return false;
    if (rule.currentBelow !== undefined && current > rule.currentBelow) return false;
    if (rule.movementAbove !== undefined && movement < rule.movementAbove) return false;
    if (rule.movementBelow !== undefined && movement > rule.movementBelow) return false;

    return true;
  }
}
