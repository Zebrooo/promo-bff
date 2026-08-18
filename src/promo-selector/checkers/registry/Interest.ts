import { Checker, type CheckContext } from '../Checker';
import type { Promo } from '../../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 7;
/** Потолок = окно RPC promo_viewer_behavior (14 дней, миграция abkhaz-auto). */
const MAX_LOOKBACK_DAYS = 14;

function configuredCategories(promo: Promo): string[] {
  return (promo.targeting.behavior?.interest?.categories ?? []).filter((v) => v.trim() !== '');
}

/** A non-empty configured category is a rule even if it is later found invalid. */
export function hasInterestRule(promo: Promo): boolean {
  return configuredCategories(promo).length > 0;
}

/** Gates promos by the categories of listings the viewer actually opened. */
export class InterestChecker extends Checker {
  readonly name = 'interest';

  expect() {
    return 'viewer opened a listing of a targeted category within the lookback window';
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasInterestRule(ctx.promo) ? false : 'no interest targeting';
  }

  check(ctx: CheckContext): boolean {
    const rule = ctx.promo.targeting.behavior?.interest;
    const raw = rule?.categories ?? [];
    const configured = raw.filter((v) => v.trim() !== '');
    // Hand-built promos can bypass Zod. Never turn an invalid configured rule
    // into a skip/pass (принцип SearchChecker): пустые строки или окно вне
    // 1..14 — это fail, а не «покажем всем».
    if (configured.length === 0 || configured.length !== raw.length) return false;
    const lookbackDays = rule?.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > MAX_LOOKBACK_DAYS) {
      return false;
    }
    if (!ctx.behavior) return false; // сигнал не загружали/не смогли → fail closed

    const nowMs = ctx.now.getTime();
    const cutoffMs = nowMs - lookbackDays * DAY_MS;
    const wanted = new Set(configured.map((v) => v.trim().toLowerCase()));
    return ctx.behavior.interests.some((row) => {
      const seenMs = Date.parse(row.lastViewedAt);
      if (!Number.isFinite(seenMs) || seenMs < cutoffMs || seenMs > nowMs) return false;
      return wanted.has(row.category.trim().toLowerCase());
    });
  }
}
