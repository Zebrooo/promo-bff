import { Checker, type CheckContext, type SuppliersData } from '../Checker';
import type { Promo } from '../../types';

export function hasListingsRule(promo: Promo): boolean {
  const rule = promo.targeting.listings;
  if (!rule) return false;
  return (
    (rule.categories?.length ?? 0) > 0 ||
    (rule.activeCategories?.length ?? 0) > 0 ||
    rule.hasUnpromotedActive !== undefined ||
    rule.inactiveDays !== undefined
  );
}

function categoriesMatch(required: string[], have: string[], mode: 'any' | 'all'): boolean {
  return mode === 'all' ? required.every((c) => have.includes(c)) : required.some((c) => have.includes(c));
}

/** Gates a promo by the viewer's OWN listings: categories, active categories, upsell (unpromoted active), reactivation (inactive days). */
export class ListingsChecker extends Checker<'listingStats'> {
  readonly name = 'listings';
  readonly requiredSupplierIDs = ['listingStats'] as const;

  expect() { return "viewer's own listings match the promo's listings targeting"; }

  shouldSkip(ctx: CheckContext): false | string {
    return hasListingsRule(ctx.promo) ? false : 'no listings targeting';
  }

  check(ctx: CheckContext, data: SuppliersData<'listingStats'>): boolean {
    if (!ctx.isAuthorized) return false;
    const rule = ctx.promo.targeting.listings!;
    const stats = data.listingStats;
    const mode = rule.categoriesMatch ?? 'any';

    if (rule.categories?.length && !categoriesMatch(rule.categories, stats.everCategories, mode)) return false;
    if (rule.activeCategories?.length && !categoriesMatch(rule.activeCategories, stats.activeCategories, mode)) return false;
    if (rule.hasUnpromotedActive !== undefined && stats.hasUnpromotedActive !== rule.hasUnpromotedActive) return false;
    if (rule.inactiveDays !== undefined) {
      if (stats.daysSinceLastListing === undefined || stats.daysSinceLastListing < rule.inactiveDays) return false;
    }

    return true;
  }
}
