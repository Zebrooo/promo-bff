import { Checker, type CheckContext, type SuppliersData } from '../Checker';

/** Optional per-user impression cap. No cap configured = unlimited (skipped). */
export class LimitChecker extends Checker<'userData'> {
  readonly name = 'limit';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'user has seen the promo fewer than maxImpressionsPerUser times'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.maxImpressionsPerUser === undefined ? 'no cap configured' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    const cap = ctx.promo.maxImpressionsPerUser as number; // defined: shouldSkip guards undefined
    return (data.userData.impressionCounts[ctx.promo.id] ?? 0) < cap;
  }
}

const MS_PER_HOUR = 60 * 60 * 1000;

/**
 * Minimum hours since this viewer's latest promo impression, regardless of
 * promo id. The candidate promo supplies the window; cooldownHours <= 0 keeps
 * the checker disabled for that candidate.
 */
export class CooldownChecker extends Checker<'userData'> {
  readonly name = 'cooldown';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'at least cooldownHours have passed since the latest promo show'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.cooldownHours <= 0 ? 'no cooldown configured' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    let latestLastShownAtMs: number | undefined;
    for (const lastShownAt of Object.values(data.userData.lastShownAt)) {
      const lastShownAtMs = new Date(lastShownAt).getTime();
      if (Number.isNaN(lastShownAtMs)) continue;
      if (latestLastShownAtMs === undefined || lastShownAtMs > latestLastShownAtMs) {
        latestLastShownAtMs = lastShownAtMs;
      }
    }
    if (latestLastShownAtMs === undefined) return true;
    return ctx.now.getTime() - latestLastShownAtMs >= ctx.promo.cooldownHours * MS_PER_HOUR;
  }
}
