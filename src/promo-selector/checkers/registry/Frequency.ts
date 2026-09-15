import { Checker, type CheckContext, type SuppliersData } from '../Checker';
import { resolveCooldownRules } from '../../cooldown-rules';

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

const MS_PER_MINUTE = 60_000;

function shownAtMs(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Общая пауза формата. Источник — ДРУГОЕ промо того же формата с
 * cooldownSelfMinutes (или устаревшим cooldownHours), показанное на этом
 * устройстве меньше N минут назад. Само промо-источник под свою паузу не
 * попадает — решение владельца 15.09.2026: повтор A ограничивают лимит или
 * правило на себя в cooldownPromos.
 *
 * Имя `cooldown` сохранено от прежнего чекера: persist-очереди, replay тура и
 * skipCheckers потребителей отключают паузы по этому имени.
 */
export class CooldownSelfChecker extends Checker<'userData'> {
  readonly name = 'cooldown';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'no other promo of the same format holds a cooldownSelfMinutes pause on this device'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.pool === undefined ? 'no pool in context' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    const pool = ctx.pool;
    if (!pool) return true;
    const nowMs = ctx.now.getTime();
    for (const [sourceId, shownAt] of Object.entries(data.userData.lastShownAt)) {
      if (sourceId === ctx.promo.id) continue;
      const source = pool.get(sourceId);
      if (!source || source.format !== ctx.promo.format) continue;
      const { selfMinutes } = resolveCooldownRules(source);
      if (selfMinutes <= 0) continue;
      const shownDevice = data.userData.lastDevice?.[sourceId];
      if (shownDevice && ctx.device && shownDevice !== ctx.device) continue;
      const shownMs = shownAtMs(shownAt);
      if (shownMs === undefined) continue;
      if (nowMs - shownMs < selfMinutes * MS_PER_MINUTE) return false;
    }
    return true;
  }
}

/**
 * Направленные паузы кандидата (cooldownPromos): «не показывать B N минут
 * после показа A». Ссылка на себя допустима — это и есть «не повторять чаще
 * N минут». Устройство не учитывается: правило точечное.
 */
export class CooldownPromosChecker extends Checker<'userData'> {
  readonly name = 'cooldown-promos';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'every cooldownPromos rule has expired since the referenced promo was last shown'; }
  shouldSkip(ctx: CheckContext): false | string {
    return resolveCooldownRules(ctx.promo).promos.length === 0 ? 'no cooldownPromos configured' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    const nowMs = ctx.now.getTime();
    for (const rule of resolveCooldownRules(ctx.promo).promos) {
      const shownMs = shownAtMs(data.userData.lastShownAt[rule.promoId]);
      if (shownMs === undefined) continue;
      if (nowMs - shownMs < rule.minutes * MS_PER_MINUTE) return false;
    }
    return true;
  }
}
