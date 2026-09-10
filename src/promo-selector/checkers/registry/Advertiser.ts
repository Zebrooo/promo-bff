import { Checker, type CheckContext } from '../Checker';
import type { Promo } from '../../types';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Дефолт окна для abandonedWizard (спека кабинета 2026-09-09-targeting-advertiser). */
export const DEFAULT_WIZARD_LOOKBACK_DAYS = 30;

/** Есть ли в блоке настоящее условие: модификаторы (launchedWithinDays,
 *  wizardLookbackDays, minSpentKopecks) и пустой список статусов не в счёт —
 *  зеркало hasAdvertiserCriteria кабинета (lib/targeting-normalize.ts). */
export function hasAdvertiserRule(promo: Promo): boolean {
  const rule = promo.targeting.advertiser;
  if (!rule) return false;
  return (
    (rule.campaignStatuses?.length ?? 0) > 0 ||
    rule.hasActiveCampaign !== undefined ||
    rule.everLaunched !== undefined ||
    rule.abandonedWizard !== undefined ||
    rule.paidCampaigns !== undefined ||
    rule.budgetExhausted !== undefined ||
    rule.walletAtMostKopecks !== undefined
  );
}

/** Окно событий мастера, которое нужно этому промо (0 = мастер не проверяется). */
export function wizardWindowDaysFor(promo: Promo): number {
  const rule = promo.targeting.advertiser;
  if (!rule || rule.abandonedWizard === undefined) return 0;
  return rule.wizardLookbackDays ?? DEFAULT_WIZARD_LOOKBACK_DAYS;
}

/** Нужен ли этому промо баланс рекламного кошелька (читается вместе с BalanceChecker). */
export function needsAdvertiserWallet(promo: Promo): boolean {
  return hasAdvertiserRule(promo) && promo.targeting.advertiser!.walletAtMostKopecks !== undefined;
}

function isPositiveInt(v: number): boolean {
  return Number.isInteger(v) && v >= 1;
}

/**
 * Ось «Рекламодатель» (promo.targeting.advertiser, спека кабинета
 * 2026-09-09-targeting-advertiser-design): условия по рекламным кампаниям
 * зрителя и мастеру подачи РК. Все заданные условия — И; внутри
 * campaignStatuses — ИЛИ. Гость не проходит никогда; сигнал не загружен
 * (сбой Supabase, нет account-идентичности) → fail closed для всего правила,
 * даже если часть условий выполнилась бы «на нуле». Кошелёк читается тем же
 * загрузчиком, что у BalanceChecker (ctx.walletBalanceKopecks).
 */
export class AdvertiserChecker extends Checker {
  readonly name = 'advertiser';

  expect() {
    return "viewer's ad campaigns / campaign wizard match every promo.targeting.advertiser condition (AND)";
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasAdvertiserRule(ctx.promo) ? false : 'no advertiser targeting';
  }

  check(ctx: CheckContext): boolean {
    if (!ctx.isAuthorized) return false;
    const rule = ctx.promo.targeting.advertiser!;
    const s = ctx.advertiser;
    if (!s) return false;
    const nowMs = ctx.now.getTime();

    if (rule.campaignStatuses !== undefined && rule.campaignStatuses.length > 0) {
      const wanted = rule.campaignStatuses.filter((x) => x.trim() !== '');
      // Рукописный список с пустыми строками — невалидное правило (принцип
      // LifecycleChecker: invalid configured rule = fail, not pass).
      if (wanted.length !== rule.campaignStatuses.length) return false;
      if (!wanted.some((x) => s.statuses.includes(x))) return false;
    }

    if (rule.hasActiveCampaign !== undefined && s.hasActive !== rule.hasActiveCampaign) return false;

    if (rule.everLaunched !== undefined) {
      const launched = s.lastLaunchedAt !== null;
      if (launched !== rule.everLaunched) return false;
      if (rule.everLaunched && rule.launchedWithinDays !== undefined) {
        if (!isPositiveInt(rule.launchedWithinDays)) return false;
        const ms = Date.parse(s.lastLaunchedAt ?? '');
        if (!Number.isFinite(ms) || nowMs - ms > rule.launchedWithinDays * DAY_MS) return false;
      }
    }

    if (rule.abandonedWizard !== undefined) {
      const windowDays = rule.wizardLookbackDays ?? DEFAULT_WIZARD_LOOKBACK_DAYS;
      if (!isPositiveInt(windowDays)) return false;
      // События загружены на меньшее окно, чем просит правило (не должно
      // случаться: загрузчик берёт максимум по очереди) — данных нет, fail closed.
      if (s.wizardWindowDays < windowDays) return false;
      const sinceMs = nowMs - windowDays * DAY_MS;
      let lastStart = -Infinity;
      let lastSubmit = -Infinity;
      for (const e of s.wizardEvents) {
        const ms = Date.parse(e.at);
        if (!Number.isFinite(ms) || ms < sinceMs) continue;
        if (e.kind === 'start') lastStart = Math.max(lastStart, ms);
        else lastSubmit = Math.max(lastSubmit, ms);
      }
      // «Бросил» = последний старт мастера в окне не закрыт отправкой после него.
      const abandoned = Number.isFinite(lastStart) && lastSubmit < lastStart;
      if (abandoned !== rule.abandonedWizard) return false;
    }

    if (rule.paidCampaigns !== undefined) {
      const paid = s.spentKopecks > 0;
      if (paid !== rule.paidCampaigns) return false;
      if (rule.paidCampaigns && rule.minSpentKopecks !== undefined && s.spentKopecks < rule.minSpentKopecks) return false;
    }

    if (rule.budgetExhausted !== undefined && s.budgetExhausted !== rule.budgetExhausted) return false;

    if (rule.walletAtMostKopecks !== undefined) {
      // Как у BalanceChecker: сбой чтения баланса — fail closed, отсутствие
      // счёта — законный 0 (кошелёк не заведён = пустой).
      if (ctx.walletBalanceUnavailable) return false;
      if ((ctx.walletBalanceKopecks ?? 0) > rule.walletAtMostKopecks) return false;
    }

    return true;
  }
}
