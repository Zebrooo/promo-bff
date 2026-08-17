import { Checker, type SupplierId } from './Checker';
import { DateChecker } from './registry/Date';
import { TargetingChecker } from './registry/Targeting';
import { AudienceChecker } from './registry/Audience';
import { ContextChecker } from './registry/Context';
import { SearchChecker } from './registry/Search';
import { PurchaseChecker } from './registry/Purchases';
import { BalanceChecker } from './registry/Balance';
import { DeviceChecker } from './registry/Device';
import { EnvChecker } from './registry/Env';
import { FormatChecker } from './registry/Format';
import { SellerChecker } from './registry/Seller';
import { ListingsChecker } from './registry/Listings';
import { LimitChecker, CooldownChecker } from './registry/Frequency';
import { ChainChecker } from './registry/Chain';

export { Checker } from './Checker';
export type { CheckContext, SupplierId, SuppliersData, UserData, Logger } from './Checker';
export type { SearchHistoryEntry, PurchaseEntry } from './Checker';
export { loadSuppliers, type SupplierDeps } from './suppliers';

/** Web checker collection, in evaluation order. */
export const WEB_CHECKERS: Checker<SupplierId>[] = [
  new DateChecker(),
  new TargetingChecker(),
  new AudienceChecker(),
  new ContextChecker(),
  new SearchChecker(),
  new PurchaseChecker(),
  new BalanceChecker(),
  new DeviceChecker(),
  new EnvChecker(),
  new FormatChecker(),
  new SellerChecker(),
  new ListingsChecker(),
  new LimitChecker(),
  new CooldownChecker(),
  new ChainChecker(),
];
