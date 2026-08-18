import { Checker, type CheckContext, type SuppliersData } from '../Checker';

/**
 * Promo chaining. Два независимых условия, объединяемые по AND:
 *  - `afterPromoId`      — предшественник ПОКАЗАН (impressionCounts > 0), как раньше;
 *  - `afterClickPromoId` — по предшественнику КЛИКНУЛИ (clickCounts > 0), т.е.
 *    явный интерес, а не пролистанный показ.
 * Ни одно поле не задано = not chained (skipped).
 *
 * NB: the tour replay mechanic sends skipCheckers ['limit','cooldown'] — 'chain'
 * is deliberately NOT in that list, so the chain order holds during replay too.
 * Keep it that way: skipping 'chain' on replay would surface successors before
 * their predecessor. (Онбординг-тур дропает 'chain' целиком — оба поля там
 * игнорируются, порядком владеет queue-index.)
 */
export class ChainChecker extends Checker<'userData'> {
  readonly name = 'chain';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'the user has seen the afterPromoId predecessor and/or clicked the afterClickPromoId predecessor'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.afterPromoId === undefined && ctx.promo.afterClickPromoId === undefined
      ? 'no chain configured'
      : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    const { afterPromoId, afterClickPromoId } = ctx.promo;
    if (afterPromoId !== undefined && (data.userData.impressionCounts[afterPromoId] ?? 0) === 0) return false;
    if (afterClickPromoId !== undefined && (data.userData.clickCounts[afterClickPromoId] ?? 0) === 0) return false;
    return true;
  }
}
