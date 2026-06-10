import { Checker, type CheckContext, type SuppliersData } from '../Checker';

/** Restricts a promo to sellers (active listings > 0) or buyers (none). */
export class SellerChecker extends Checker<'listingStats'> {
  readonly name = 'seller';
  readonly requiredSupplierIDs = ['listingStats'] as const;
  expect() { return 'user matches the promo sellerStatus (seller/buyer)'; }
  shouldSkip(ctx: CheckContext): false | string {
    return ctx.promo.sellerStatus === undefined ? 'no sellerStatus gate' : false;
  }
  check(ctx: CheckContext, data: SuppliersData<'listingStats'>): boolean {
    const isSeller = data.listingStats.activeListings > 0;
    return ctx.promo.sellerStatus === 'seller' ? isSeller : !isSeller;
  }
}
