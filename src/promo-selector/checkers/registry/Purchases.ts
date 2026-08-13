import { Checker, type CheckContext, type PurchaseEntry } from '../Checker';
import type { Promo } from '../../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;

export function hasPurchaseRule(promo: Promo): boolean {
  const rule = promo.targeting.purchases;
  if (!rule) return false;
  return (
    rule.purchased !== undefined ||
    rule.minTotalKopecks !== undefined ||
    rule.maxTotalKopecks !== undefined ||
    rule.minCount !== undefined ||
    rule.maxCount !== undefined ||
    (rule.packTypes?.length ?? 0) > 0
  );
}

function inWindow(entries: PurchaseEntry[], now: Date, lookbackDays: number): PurchaseEntry[] {
  const cutoffMs = now.getTime() - lookbackDays * DAY_MS;
  return entries.filter((e) => {
    const createdMs = Date.parse(e.createdAt);
    return Number.isFinite(createdMs) && createdMs >= cutoffMs && createdMs <= now.getTime();
  });
}

/** Gates promos by the request viewer's pack-purchase history (bump/premium/vip). */
export class PurchaseChecker extends Checker {
  readonly name = 'purchases';

  expect() {
    return "viewer's pack purchase history matches the promo's purchase targeting";
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasPurchaseRule(ctx.promo) ? false : 'no purchase targeting';
  }

  // isAuthorized-гейт — здесь, не в shouldSkip: неавторизованный обязан
  // ПРОВАЛИТЬ правило (false), а не пройти как "не применимо" (skip == eligible).
  check(ctx: CheckContext): boolean {
    if (!ctx.isAuthorized) return false;
    // ctx.purchases is only ever undefined here because the fetch failed — this
    // checker only runs when hasPurchaseRule(ctx.promo) is true, which means the
    // loader was asked for purchases; "not needed" never reaches check() (shouldSkip
    // gates that). Fail the whole rule closed rather than silently treating an
    // outage as "genuinely zero purchases".
    if (ctx.purchases === undefined) return false;
    const rule = ctx.promo.targeting.purchases!;
    const lookbackDays = rule.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const windowed = inWindow(ctx.purchases, ctx.now, lookbackDays);
    const filtered = rule.packTypes?.length
      ? windowed.filter((e) => rule.packTypes!.includes(e.pack))
      : windowed;

    if (rule.purchased === false && filtered.length > 0) return false;
    if (rule.purchased === true && filtered.length === 0) return false;
    if (rule.minCount !== undefined && filtered.length < rule.minCount) return false;
    if (rule.maxCount !== undefined && filtered.length > rule.maxCount) return false;

    const total = filtered.reduce((sum, e) => sum + e.amountKopecks, 0);
    if (rule.minTotalKopecks !== undefined && total < rule.minTotalKopecks) return false;
    if (rule.maxTotalKopecks !== undefined && total > rule.maxTotalKopecks) return false;

    return true;
  }
}
