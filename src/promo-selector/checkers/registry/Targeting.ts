import { Checker, type CheckContext, type SuppliersData } from '../Checker';

/** The user must fall within the promo's age / region / subscription targeting. */
export class TargetingChecker extends Checker<'userData'> {
  readonly name = 'targeting';
  readonly requiredSupplierIDs = ['userData'] as const;
  expect() { return 'user matches age/region/subscription targeting'; }
  shouldSkip(ctx: CheckContext): false | string {
    const t = ctx.promo.targeting;
    const hasRules =
      t.minAge !== undefined ||
      t.maxAge !== undefined ||
      (t.regions?.length ?? 0) > 0 ||
      (t.subscriptionLevels?.length ?? 0) > 0;
    return hasRules ? false : 'no targeting rules';
  }
  check(ctx: CheckContext, data: SuppliersData<'userData'>): boolean {
    const t = ctx.promo.targeting;
    const u = data.userData;
    const ageGated = t.minAge !== undefined || t.maxAge !== undefined;
    if (ageGated && u.age === undefined) return false; // can't confirm age → don't show (like unknown region)
    if (t.minAge !== undefined && u.age !== undefined && u.age < t.minAge) return false;
    if (t.maxAge !== undefined && u.age !== undefined && u.age > t.maxAge) return false;
    if (t.regions?.length && !t.regions.includes(u.region)) return false;
    if (t.subscriptionLevels?.length && !t.subscriptionLevels.includes(u.subscriptionLevel)) return false;
    return true;
  }
}
