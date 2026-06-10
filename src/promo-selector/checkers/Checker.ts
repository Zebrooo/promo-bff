import type { Promo, SubscriptionLevel } from '../types';

/** Per-promo evaluation context (identity + clock + the candidate promo). */
export interface CheckContext {
  promo: Promo;
  userId: string;
  authenticated: boolean;
  now: Date;
  /** Page section the user is browsing (overlay only; undefined elsewhere). */
  section?: string;
  /** Page category the user is browsing. */
  category?: string;
}

/** All known supplier ids. */
export type SupplierId = 'userData' | 'listingStats';

/** Aggregated per-user data the userData supplier provides. */
export interface UserData {
  /** Full years; undefined when the user has no birthdate. */
  age?: number;
  region: string;
  subscriptionLevel: SubscriptionLevel;
  impressionCounts: Record<string, number>;
  lastShownAt: Record<string, string>;
}

/** Aggregated listing facts the listingStats supplier provides. */
export interface ListingStats {
  /** Count of the user's currently active listings (0 for anonymous/buyers). */
  activeListings: number;
}

interface SupplierTypeMap {
  userData: UserData;
  listingStats: ListingStats;
}

/** Typed bag of the data for exactly the supplier ids a checker declared. */
export type SuppliersData<SID extends SupplierId> = { [K in SID]: SupplierTypeMap[K] };

/** Minimal logger shape; Fastify's logger satisfies it, tests pass nothing. */
export interface Logger {
  debug?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

export abstract class Checker<SID extends SupplierId = never> {
  abstract readonly name: string;
  readonly requiredSupplierIDs: readonly SID[] = [] as readonly SID[];

  /** What must hold for this checker to pass (for logs). */
  abstract expect(): string;

  /** Self-skip: false = run; a string = skip with that reason (counts as eligible). */
  shouldSkip(_ctx: CheckContext): false | string {
    return false;
  }

  /** Core predicate; sees only its declared suppliers' data. Public for direct testing. */
  abstract check(ctx: CheckContext, data: SuppliersData<SID>): boolean | Promise<boolean>;

  /** Lifecycle: log expect → shouldSkip → check → log result. Fails closed on throw. */
  async run(ctx: CheckContext, data: SuppliersData<SID>, logger?: Logger): Promise<boolean> {
    logger?.debug?.({ checker: this.name, expect: this.expect() }, 'checker:expect');
    const reason = this.shouldSkip(ctx);
    if (reason) {
      logger?.debug?.({ checker: this.name, reason }, 'checker:skipped');
      return true;
    }
    try {
      const ok = await this.check(ctx, data);
      logger?.debug?.({ checker: this.name, ok }, ok ? 'checker:pass' : 'checker:mismatch');
      return ok;
    } catch (err) {
      logger?.error?.({ checker: this.name, err }, 'checker:error');
      return false;
    }
  }
}
