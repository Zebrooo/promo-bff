import { Checker, type CheckContext, type SuppliersData } from '../Checker';

/**
 * Promo chaining: a promo with `afterPromoId` shows ONLY after the user has at
 * least one recorded impression of that predecessor. No `afterPromoId` = not
 * chained (skipped).
 *
 * NB: the tour replay mechanic sends skipCheckers ['limit','cooldown'] — 'chain'
 * is deliberately NOT in that list, so the chain order holds during replay too.
 * Keep it that way: skipping 'chain' on replay would surface successors before
 * their predecessor.
 */
export class ChainChecker extends Checker<'userData'> {
  readonly name = 'chain';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'the user has already seen the afterPromoId predecessor'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.afterPromoId === undefined ? 'no chain configured' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    const predecessorId = ctx.promo.afterPromoId as string; // defined: shouldSkip guards undefined
    return (data.userData.impressionCounts[predecessorId] ?? 0) > 0;
  }
}
