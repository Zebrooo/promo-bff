import { Checker, type SupplierId } from './Checker';
import { DateChecker } from './registry/Date';
import { TargetingChecker } from './registry/Targeting';
import { AudienceChecker } from './registry/Audience';
import { ContextChecker } from './registry/Context';
import { SellerChecker } from './registry/Seller';
import { LimitChecker, CooldownChecker } from './registry/Frequency';

export { Checker } from './Checker';
export type { CheckContext, SupplierId, SuppliersData, UserData, Logger } from './Checker';
export { loadSuppliers, type SupplierDeps } from './suppliers';

/** Web checker collection, in evaluation order. */
export const WEB_CHECKERS: Checker<SupplierId>[] = [
  new DateChecker(),
  new TargetingChecker(),
  new AudienceChecker(),
  new ContextChecker(),
  new SellerChecker(),
  new LimitChecker(),
  new CooldownChecker(),
];
