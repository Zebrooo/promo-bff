import type { UserService } from '../../services/user-service';
import type { BillingService } from '../../services/billing-service';
import type { ImpressionStore } from '../../services/impression-store';
import type { ListingService } from '../../services/listing-service';
import { Checker, type IdentityKind, type ListingStats, type SupplierId, type SuppliersData, type UserData } from './Checker';

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
// Process-wide cache for slow-moving account-backed data only, keyed by
// `${supplierId}:${userId}:${identityKind}`. Authorization is deliberately not
// in the key: login/logout of the same proven account identity reuses profile,
// billing and listing data. Impression history is NEVER cached here; every
// selection reads it fresh so a just-recorded impression immediately affects
// cooldown/frequency, including across multiple BFF instances.
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
type CacheableSupplierId = 'accountData' | 'listingStats';

async function cached<T>(supplierId: CacheableSupplierId, userId: string, identityKind: IdentityKind, load: () => Promise<T>): Promise<T> {
  const nowMs = Date.now();
  const key = `${supplierId}:${userId}:${identityKind}`;
  const hit = supplierCache.get(key);
  if (hit && hit.expiresAt > nowMs) return hit.data as T;
  // Cold-key concurrency: concurrent requests for the same cold key each load
  // (no in-flight dedup). Acceptable for a single-instance BFF with a 60s TTL.
  const data = await load();
  supplierCache.set(key, { data, expiresAt: nowMs + USERDATA_TTL_MS });
  pruneIfLarge(Date.now());
  return data;
}

interface AccountData {
  age?: number;
  region: string;
  subscriptionLevel: UserData['subscriptionLevel'];
}

function loadAccountData(userId: string, identityKind: IdentityKind, deps: SupplierDeps): Promise<AccountData> {
  if (identityKind === 'anonymous') {
    return Promise.resolve({ age: undefined, region: '', subscriptionLevel: 'none' });
  }
  return cached('accountData', userId, identityKind, async () => {
    const [profile, subscription] = await Promise.all([
      deps.userService.getUserProfile(userId),
      deps.billingService.getSubscription(userId),
    ]);
    return { age: profile.age, region: profile.region, subscriptionLevel: subscription.level };
  });
}

async function loadUserData(userId: string, identityKind: IdentityKind, deps: SupplierDeps): Promise<UserData> {
  // Impression ids exist for account and anonymous cookie identities. Keep this
  // call outside every TTL cache: POST /impressions must affect the very next
  // selection and another instance must see the shared-store write immediately.
  const [account, impressions] = await Promise.all([
    loadAccountData(userId, identityKind, deps),
    deps.impressionStore.getImpressions(userId),
  ]);
  return {
    ...account,
    impressionCounts: impressions.counts,
    lastShownAt: impressions.lastShownAt,
  };
}

function loadListingStats(userId: string, identityKind: IdentityKind, deps: SupplierDeps): Promise<ListingStats> {
  // Anonymous ids are not profiles.id/sellers → no listings; skip the query.
  if (identityKind === 'anonymous') return Promise.resolve({ activeListings: 0 });
  return cached('listingStats', userId, identityKind, () => deps.listingService.getListingStats(userId));
}

/** Loads the union of suppliers required by the active checkers, once each. */
export async function loadSuppliers(
  active: Checker<SupplierId>[],
  ctx: { userId: string; identityKind: IdentityKind },
  deps: SupplierDeps,
): Promise<Partial<SuppliersData<SupplierId>>> {
  const ids = new Set<SupplierId>(active.flatMap((c) => [...c.requiredSupplierIDs]));
  const data: Partial<SuppliersData<SupplierId>> = {};
  // userData loads whenever any active checker declares it. Account metadata may
  // hit its TTL cache, while impressions always come from the shared store.
  if (ids.has('userData')) data.userData = await loadUserData(ctx.userId, ctx.identityKind, deps);
  if (ids.has('listingStats')) data.listingStats = await loadListingStats(ctx.userId, ctx.identityKind, deps);
  return data;
}
