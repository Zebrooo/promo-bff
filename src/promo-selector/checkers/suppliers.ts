import type { UserService } from '../../services/user-service';
import type { BillingService } from '../../services/billing-service';
import type { ImpressionStore } from '../../services/impression-store';
import type { ListingService } from '../../services/listing-service';
import { Checker, type ListingStats, type SupplierId, type SuppliersData, type UserData } from './Checker';

export interface SupplierDeps {
  userService: UserService;
  billingService: BillingService;
  impressionStore: ImpressionStore;
  listingService: ListingService;
}

export const USERDATA_TTL_MS = 60_000;
const CACHE_SWEEP_THRESHOLD = 1000;

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}
// Process-wide, keyed by `${supplierId}:${userId}`, 60s TTL. Because impressions
// are part of the cached userData, an impression recorded via POST /impressions
// is not reflected in limit/cooldown for up to TTL on this instance. Acceptable:
// caps are measured in counts/hours, far coarser than the TTL.
const supplierCache = new Map<string, CacheEntry>();

/** Test-only: empties the whole supplier cache (all suppliers). */
export function __clearUserDataCache(): void {
  supplierCache.clear();
}

function pruneIfLarge(nowMs: number): void {
  if (supplierCache.size <= CACHE_SWEEP_THRESHOLD) return;
  for (const [key, entry] of supplierCache) {
    if (entry.expiresAt <= nowMs) supplierCache.delete(key);
  }
}

/** Cache wrapper shared by all suppliers: serve within TTL, else load + store. */
async function cached<T>(supplierId: SupplierId, userId: string, load: () => Promise<T>): Promise<T> {
  const nowMs = Date.now();
  const key = `${supplierId}:${userId}`;
  const hit = supplierCache.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.data as T;
  // Cold-key concurrency: concurrent requests for the same cold key each load
  // (no in-flight dedup). Acceptable for a single-instance BFF with a 60s TTL.
  const data = await load();
  supplierCache.set(key, { data, expiresAt: nowMs + USERDATA_TTL_MS });
  pruneIfLarge(Date.now());
  return data;
}

function loadUserData(userId: string, authenticated: boolean, deps: SupplierDeps): Promise<UserData> {
  return cached('userData', userId, async () => {
    // Impressions are keyed by id for everyone (incl. anonymous cookie ids).
    // Profile + subscription only exist for authenticated users (profiles.id), so
    // skip those queries for anonymous callers and use neutral defaults.
    const impressions = await deps.impressionStore.getImpressions(userId);
    let region = '';
    let subscriptionLevel: UserData['subscriptionLevel'] = 'none';
    let age: number | undefined = undefined;
    if (authenticated) {
      const [profile, subscription] = await Promise.all([
        deps.userService.getUserProfile(userId),
        deps.billingService.getSubscription(userId),
      ]);
      age = profile.age;
      region = profile.region;
      subscriptionLevel = subscription.level;
    }
    return { age, region, subscriptionLevel, impressionCounts: impressions.counts, lastShownAt: impressions.lastShownAt };
  });
}

function loadListingStats(userId: string, authenticated: boolean, deps: SupplierDeps): Promise<ListingStats> {
  // Anonymous ids are not profiles.id/sellers → no listings; skip the query.
  if (!authenticated) return Promise.resolve({ activeListings: 0 });
  return cached('listingStats', userId, () => deps.listingService.getListingStats(userId));
}

/** Loads the union of suppliers required by the active checkers, once each. */
export async function loadSuppliers(
  active: Checker<SupplierId>[],
  ctx: { userId: string; authenticated: boolean },
  deps: SupplierDeps,
): Promise<Partial<SuppliersData<SupplierId>>> {
  const ids = new Set<SupplierId>(active.flatMap((c) => [...c.requiredSupplierIDs]));
  const data: Partial<SuppliersData<SupplierId>> = {};
  // userData loads whenever any active checker declares it — so targeting alone
  // triggers the (impression-bundled) load even when limit/cooldown are skipped.
  if (ids.has('userData')) data.userData = await loadUserData(ctx.userId, ctx.authenticated, deps);
  if (ids.has('listingStats')) data.listingStats = await loadListingStats(ctx.userId, ctx.authenticated, deps);
  return data;
}
