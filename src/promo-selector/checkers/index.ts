import { Checker, type SupplierId } from './Checker';
import { DateChecker } from './registry/Date';
import { TargetingChecker } from './registry/Targeting';
import { GeoChecker } from './registry/Geo';
import { AudienceChecker } from './registry/Audience';
import { VisitorChecker } from './registry/Visitor';
import { SourceChecker } from './registry/Source';
import { ContextChecker } from './registry/Context';
import { SearchChecker } from './registry/Search';
import { PurchaseChecker } from './registry/Purchases';
import { BalanceChecker } from './registry/Balance';
import { InterestChecker } from './registry/Interest';
import { HotBuyerChecker } from './registry/HotBuyer';
import { EngagementChecker } from './registry/Engagement';
import { DeviceChecker } from './registry/Device';
import { EnvChecker } from './registry/Env';
import { FormatChecker } from './registry/Format';
import { SellerChecker } from './registry/Seller';
import { LifecycleChecker } from './registry/Lifecycle';
import { ListingsChecker } from './registry/Listings';
import { LimitChecker, CooldownChecker } from './registry/Frequency';
import { ReactionChecker } from './registry/Reaction';
import { ChainChecker } from './registry/Chain';

export { Checker } from './Checker';
export type { CheckContext, SupplierId, SuppliersData, UserData, Logger } from './Checker';
export type { SearchHistoryEntry, PurchaseEntry, BehaviorSignal } from './Checker';
export { loadSuppliers, type SupplierDeps } from './suppliers';

/** Web checker collection, in evaluation order. */
export const WEB_CHECKERS: Checker<SupplierId>[] = [
  new DateChecker(),
  new TargetingChecker(),
  new GeoChecker(),
  new AudienceChecker(),
  new VisitorChecker(),
  new SourceChecker(),
  new ContextChecker(),
  new SearchChecker(),
  new PurchaseChecker(),
  new BalanceChecker(),
  new InterestChecker(),
  new HotBuyerChecker(),
  new EngagementChecker(),
  new DeviceChecker(),
  new EnvChecker(),
  new FormatChecker(),
  new SellerChecker(),
  new LifecycleChecker(),
  new ListingsChecker(),
  new LimitChecker(),
  new CooldownChecker(),
  new ReactionChecker(),
  new ChainChecker(),
];
