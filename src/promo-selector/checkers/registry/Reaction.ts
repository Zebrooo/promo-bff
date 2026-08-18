import { Checker, type CheckContext, type SuppliersData } from '../Checker';

/**
 * Анти-таргетинг по реакции: промо с `suppressAfterClick: true` перестаёт
 * показываться пользователю, который уже кликнул по его CTA (или достиг
 * конверсии — click-store суммирует оба kind'а в clickCounts). Клик — стоп-
 * сигнал: сработало — не мешаем, слот достаётся следующему промо очереди.
 * Нет флага = поведение не меняется (skip).
 *
 * Fail-модель: по правилу — fail-closed (throw в run() блокирует кандидата,
 * как у всех чекеров); по данным — fail-soft: сбой чтения promo_clicks
 * деградирует в clickCounts = {} ещё в suppliers.loadUserData, промо тогда
 * покажется лишний раз (перепоказ — принятый компромисс, спека §6).
 */
export class ReactionChecker extends Checker<'userData'> {
  readonly name = 'reaction';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'the user has not clicked this promo (suppressAfterClick)'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.suppressAfterClick !== true ? 'suppressAfterClick not set' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    return (data.userData.clickCounts[ctx.promo.id] ?? 0) === 0;
  }
}
