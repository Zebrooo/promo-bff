# Чекер «Объявления продавца» Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Новый чекер `ListingsChecker` в promo-bff, таргетирующий промо по
собственным объявлениям продавца (категории/активные категории/непродвинутые
активные объявления/давность последнего размещения), плюс соответствующий UI
в promo-cabinet.

**Architecture:** Расширяем существующий supplier `listingStats`
(`listing-service.ts`) одним обогащённым REST-запросом вместо текущего
облегчённого count-запроса; новый чекер читает те же данные через
`requiredSupplierIDs: ['listingStats']` (снимок-паттерн `SellerChecker`, БЕЗ
окна `lookbackDays` — не нужно трогать `promo-selector/index.ts`/
`SelectPromoContext`, суппилеры прокидываются в чекеры уже общим механизмом
`loadSuppliers()`). Правило целиком — новое поле `targeting.listings` в
`PromoTargeting`.

**Tech Stack:** promo-bff (Fastify/TypeScript/Vitest), promo-cabinet
(Next.js/Formik/Zod/Vitest).

## Global Constraints

- Анонимный посетитель (`ctx.isAuthorized === false`) с непустым правилом
  `listings` — `check()` возвращает `false` (fail-closed), как у
  `PurchaseChecker`/`BalanceChecker`. Пустое правило — обычный skip.
- Между непустыми полями правила — AND (проходят все заданные условия).
  `categoriesMatch: 'any' | 'all'` (default `'any'`) — общий флаг на
  `categories` И `activeCategories`.
- Суммы/пороги здесь не в kopecks — все числовые поля правила либо счётчики
  дней (`inactiveDays`), либо булевы/строковые — конвертации рубли↔копейки
  в этой задаче нет.
- **promo-bff часть (Tasks 1-4) исполняется независимо и НЕ ждёт merge
  `feat/purchase-balance-checkers`** — уже своя ветка `feat/listings-targeting-checker`
  от свежего `origin/main`.
- **promo-cabinet часть (Tasks 5-7) исполняется ПОСЛЕ мержа
  `feat/purchase-balance-checkers` (promo-cabinet) в main** — обе ветки
  трогают одни и те же файлы (`schema.ts`, `to-persisted.ts`,
  `TargetingSection.tsx`); избежание конфликта, не архитектурное ограничение.
  Task 5's брифинг должен явно свериться, что merge уже произошёл, прежде
  чем создавать ветку `feat/listings-targeting-checker` в promo-cabinet.
- КРИТИЧНО (урок из параллельной задачи): любое новое поле
  `targeting.<X>` должно быть добавлено И в `catalogue-schema.ts`'s
  `promoSchema.targeting` (promo-bff, live-путь через
  `config-service.ts`/`parsePoolLeniently`), И в `schema.ts`'s
  `servingBlockSchema.targeting` (promo-cabinet) — иначе Zod молча вырежет
  поле из распарсенного промо, и чекер никогда не увидит правило, несмотря
  на то что весь остальной код будет полностью рабочим. Task 4 явно
  покрывает `catalogue-schema.ts`; Task 5 — `schema.ts` кабинета.

---

## Task 1: promo-bff — тип `ListingsTargetingRule`

**Files:**
- Modify: `src/promo-selector/types.ts`

**Interfaces:**
- Produces: `PromoTargeting.listings?: { categories?, categoriesMatch?, activeCategories?, hasUnpromotedActive?, inactiveDays? }` — используется в Tasks 2-4.

- [ ] **Step 1: Добавить поле в `PromoTargeting`**

В `src/promo-selector/types.ts`, внутри интерфейса `PromoTargeting`, сразу
после блока `search?: {...};` (закрывающая `};` того блока):

```ts
  /** Own-listings gate: categories/active-categories/upsell/reactivation. Omitted/empty means no listings targeting. */
  listings?: {
    /** Ever listed (any status) in one of these category slugs. */
    categories?: string[];
    /** Whether categories/activeCategories require ANY or ALL to match. Defaults to `any`. */
    categoriesMatch?: 'any' | 'all';
    /** Has an ACTIVE listing in one of these category slugs. */
    activeCategories?: string[];
    /** Has an active listing without current promotion (upsell gate). */
    hasUnpromotedActive?: boolean;
    /** Minimum days since the user's most recent listing (any status). */
    inactiveDays?: number;
  };
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no code reads this field yet, so nothing else can break).

- [ ] **Step 3: Commit**

```bash
git add src/promo-selector/types.ts
git commit -m "feat(types): add PromoTargeting.listings"
```

---

## Task 2: promo-bff — расширить `ListingStats`/`listing-service.ts`

**Files:**
- Modify: `src/services/listing-service.ts`
- Modify: `src/promo-selector/checkers/Checker.ts`
- Modify: `src/test-utils.ts`
- Test: `src/services/listing-service.test.ts`

**Interfaces:**
- Consumes: ничего из Task 1.
- Produces: `ListingStats { activeListings: number; everCategories: string[]; activeCategories: string[]; hasUnpromotedActive: boolean; daysSinceLastListing?: number }`, `computeStats(rows: ListingRow[], nowMs: number): ListingStats` (exported for direct testing) — используется в Task 3.

**Контекст:** сейчас `listing-service.ts` делает облегчённый
`select=id&limit=1` + `Prefer: count=exact` запрос, отдающий только
`{ activeListings }` через заголовок `Content-Range`. Заменяем на запрос,
забирающий реальные строки (`category_slug, status, promotion,
promotion_until, created_at`, до 200 штук), из которых в JS считаются все 5
полей. `activeListings` теперь считается длиной отфильтрованного массива, а
не заголовком — при >200 объявлений у одного юзера (гипотетический случай)
count был бы неточным; не оптимизируем под этот хвост.

Также сейчас `ListingStats` **задублирован**: `listing-service.ts`
определяет его как источник истины, но `Checker.ts` НЕЗАВИСИМО
переопределяет одноимённый интерфейс с той же формой (`{ activeListings:
number }`) для `SupplierTypeMap`. Раз мы добавляем новые поля, дублирование
станет ловушкой рассинхрона — заменяем локальное определение в `Checker.ts`
на реэкспорт из `listing-service.ts`.

- [ ] **Step 1: Написать падающий тест**

Полностью заменить содержимое `src/services/listing-service.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createListingService, computeStats } from './listing-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };
const NOW_MS = Date.parse('2026-08-13T12:00:00.000Z');

afterEach(() => vi.restoreAllMocks());

function mockFetch(status: number, rows: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => rows,
  }) as unknown as Response));
}

describe('computeStats', () => {
  it('returns empty stats for no rows', () => {
    expect(computeStats([], NOW_MS)).toEqual({
      activeListings: 0,
      everCategories: [],
      activeCategories: [],
      hasUnpromotedActive: false,
      daysSinceLastListing: undefined,
    });
  });

  it('collects everCategories from all statuses, activeCategories only from active', () => {
    const rows = [
      { category_slug: 'avto', status: 'active', promotion: 'vip', promotion_until: '2026-09-01T00:00:00.000Z', created_at: '2026-08-01T00:00:00.000Z' },
      { category_slug: 'realty', status: 'archived', promotion: 'none', promotion_until: null, created_at: '2026-07-01T00:00:00.000Z' },
    ];
    const stats = computeStats(rows, NOW_MS);
    expect([...stats.everCategories].sort()).toEqual(['avto', 'realty']);
    expect(stats.activeCategories).toEqual(['avto']);
  });

  it('dedupes categories across multiple listings in the same category', () => {
    const rows = [
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' },
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-02T00:00:00.000Z' },
    ];
    expect(computeStats(rows, NOW_MS).activeCategories).toEqual(['avto']);
  });

  it('hasUnpromotedActive: true when an active listing has promotion=none', () => {
    const rows = [{ category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(true);
  });

  it('hasUnpromotedActive: true when promotion_until is in the past, even if promotion is set', () => {
    const rows = [{ category_slug: 'avto', status: 'active', promotion: 'vip', promotion_until: '2026-01-01T00:00:00.000Z', created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(true);
  });

  it('hasUnpromotedActive: false when the only active listing has a live promotion', () => {
    const rows = [{ category_slug: 'avto', status: 'active', promotion: 'vip', promotion_until: '2026-09-01T00:00:00.000Z', created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(false);
  });

  it('hasUnpromotedActive: false when the unpromoted listing is not active', () => {
    const rows = [{ category_slug: 'avto', status: 'archived', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' }];
    expect(computeStats(rows, NOW_MS).hasUnpromotedActive).toBe(false);
  });

  it('daysSinceLastListing: computed from the most recent created_at across ALL statuses', () => {
    const rows = [
      { category_slug: 'avto', status: 'archived', promotion: 'none', promotion_until: null, created_at: '2026-08-06T12:00:00.000Z' },
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-07-01T12:00:00.000Z' },
    ];
    expect(computeStats(rows, NOW_MS).daysSinceLastListing).toBe(7);
  });
});

describe('createListingService', () => {
  it('computes activeListings from the returned rows, not a Content-Range header', async () => {
    mockFetch(200, [
      { category_slug: 'avto', status: 'active', promotion: 'none', promotion_until: null, created_at: '2026-08-01T00:00:00.000Z' },
      { category_slug: 'avto', status: 'sold', promotion: 'none', promotion_until: null, created_at: '2026-07-01T00:00:00.000Z' },
    ]);
    const stats = await createListingService(cfg).getListingStats('seller');
    expect(stats.activeListings).toBe(1);
  });

  it('returns empty stats when unconfigured (no query)', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    const stats = await createListingService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getListingStats('u1');
    expect(stats).toEqual({
      activeListings: 0,
      everCategories: [],
      activeCategories: [],
      hasUnpromotedActive: false,
      daysSinceLastListing: undefined,
    });
    expect(f).not.toHaveBeenCalled();
  });

  it('throws on a query failure', async () => {
    mockFetch(500);
    await expect(createListingService(cfg).getListingStats('u1')).rejects.toThrow(/HTTP 500/);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npx vitest run src/services/listing-service.test.ts`
Expected: FAIL — `computeStats` не экспортируется, старый `getListingStats`
до сих пор читает `Content-Range`, а не тело ответа.

- [ ] **Step 3: Реализация — `listing-service.ts`**

Полностью заменить содержимое `src/services/listing-service.ts`:

```ts
/**
 * Listing facts backed by Supabase (PostgREST), reading abkhaz-auto `listings`.
 * Powers the seller-vs-buyer signal (activeListings) and the listings-targeting
 * checker (category/promotion/recency facts) — one row-level query serves both,
 * cached once per selection walk by `suppliers.ts`'s 60s TTL.
 *
 * Unconfigured Supabase → empty stats (everyone is a "buyer" with no listings);
 * a query failure throws.
 */
import { config, type SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

const ROW_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ListingStats {
  activeListings: number;
  everCategories: string[];
  activeCategories: string[];
  hasUnpromotedActive: boolean;
  daysSinceLastListing?: number;
}

export interface ListingService {
  getListingStats(userId: string): Promise<ListingStats>;
}

interface ListingRow {
  category_slug: string;
  status: string;
  promotion: string;
  promotion_until: string | null;
  created_at: string;
}

const EMPTY_STATS: ListingStats = {
  activeListings: 0,
  everCategories: [],
  activeCategories: [],
  hasUnpromotedActive: false,
  daysSinceLastListing: undefined,
};

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

/** Pure aggregation over one user's listing rows — exported for direct unit testing (no fetch mocking needed). */
export function computeStats(rows: ListingRow[], nowMs: number): ListingStats {
  if (rows.length === 0) return EMPTY_STATS;

  const everCategories = [...new Set(rows.map((r) => r.category_slug))];
  const activeRows = rows.filter((r) => r.status === 'active');
  const activeCategories = [...new Set(activeRows.map((r) => r.category_slug))];
  const hasUnpromotedActive = activeRows.some(
    (r) => r.promotion === 'none' || (r.promotion_until !== null && Date.parse(r.promotion_until) < nowMs),
  );
  const latestCreatedMs = Math.max(...rows.map((r) => Date.parse(r.created_at)));
  const daysSinceLastListing = Math.floor((nowMs - latestCreatedMs) / DAY_MS);

  return { activeListings: activeRows.length, everCategories, activeCategories, hasUnpromotedActive, daysSinceLastListing };
}

export function createListingService(cfg: SupabaseConfig = config.supabase): ListingService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getListingStats: async () => EMPTY_STATS };
  }
  const table = `${url}/rest/v1/listings`;

  async function getListingStats(userId: string): Promise<ListingStats> {
    const qs = new URLSearchParams({
      user_id: `eq.${userId}`,
      select: 'category_slug,status,promotion,promotion_until,created_at',
      order: 'created_at.desc',
      limit: String(ROW_LIMIT),
    });
    const res = await fetch(`${table}?${qs}`, { headers: authHeaders(serviceRoleKey) });
    if (!res.ok) throw new Error(`listing-service read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as ListingRow[];
    return computeStats(rows, Date.now());
  }

  return {
    getListingStats: (userId) =>
      withTimeout(getListingStats(userId), timeoutMs, 'listingService.getListingStats'),
  };
}
```

- [ ] **Step 4: Убрать дублирование `ListingStats` в `Checker.ts`**

В `src/promo-selector/checkers/Checker.ts` найти:

```ts
/** Aggregated listing facts the listingStats supplier provides. */
export interface ListingStats {
  /** Count of the user's currently active listings (0 for anonymous/buyers). */
  activeListings: number;
}
```

Заменить на:

```ts
export type { ListingStats } from '../../services/listing-service';
```

(Оставить это на том же месте файла, прямо перед `interface SupplierTypeMap`.)

- [ ] **Step 5: Обновить `test-utils.ts`**

В `src/test-utils.ts` найти:

```ts
export function makeListingStats(activeListings = 0): { listingStats: ListingStats } {
  return { listingStats: { activeListings } };
}
```

Заменить на (сохраняя ТУ ЖЕ сигнатуру — `Seller.test.ts` вызывает
`makeListingStats(2)` позиционным числом, менять сигнатуру нельзя):

```ts
export function makeListingStats(activeListings = 0): { listingStats: ListingStats } {
  return {
    listingStats: {
      activeListings,
      everCategories: [],
      activeCategories: [],
      hasUnpromotedActive: false,
      daysSinceLastListing: undefined,
    },
  };
}
```

- [ ] **Step 6: Убедиться, что проходит**

Run: `npx vitest run src/services/listing-service.test.ts src/promo-selector/checkers/registry/Seller.test.ts`
Expected: PASS для обоих файлов (Seller.test.ts не должен был сломаться —
он проверяет только `activeListings`, которое не изменило поведение).

- [ ] **Step 7: Полный прогон и typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, чисто.

- [ ] **Step 8: Commit**

```bash
git add src/services/listing-service.ts src/services/listing-service.test.ts src/promo-selector/checkers/Checker.ts src/test-utils.ts
git commit -m "feat(services): extend listingStats with categories/promotion/recency facts"
```

---

## Task 3: promo-bff — `ListingsChecker`

**Files:**
- Create: `src/promo-selector/checkers/registry/Listings.ts`
- Test: `src/promo-selector/checkers/registry/Listings.test.ts`

**Interfaces:**
- Consumes: `PromoTargeting.listings` (Task 1), `ListingStats` (Task 2).
- Produces: `ListingsChecker` (name `'listings'`), `hasListingsRule(promo: Promo): boolean` — используются в Task 4.

- [ ] **Step 1: Написать падающий тест**

Создать `src/promo-selector/checkers/registry/Listings.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ListingsChecker, hasListingsRule } from './Listings';
import { makeCheckContext, makePromo } from '../../../test-utils';
import type { ListingStats } from '../Checker';

const c = new ListingsChecker();

function stats(overrides: Partial<ListingStats> = {}): { listingStats: ListingStats } {
  return {
    listingStats: {
      activeListings: 0,
      everCategories: [],
      activeCategories: [],
      hasUnpromotedActive: false,
      daysSinceLastListing: undefined,
      ...overrides,
    },
  };
}

describe('hasListingsRule', () => {
  it('false when targeting.listings is undefined', () => {
    expect(hasListingsRule(makePromo({}))).toBe(false);
  });
  it('false when targeting.listings is an empty object', () => {
    expect(hasListingsRule(makePromo({ targeting: { listings: {} } }))).toBe(false);
  });
  it('true when any field is set', () => {
    expect(hasListingsRule(makePromo({ targeting: { listings: { inactiveDays: 7 } } }))).toBe(true);
  });
});

describe('ListingsChecker', () => {
  it('skips when no listings targeting is set', () => {
    expect(c.shouldSkip(makeCheckContext({ promo: makePromo({}) }))).toBeTruthy();
  });

  it('fails closed for an unauthorized viewer even with data present', () => {
    const ctx = makeCheckContext({
      isAuthorized: false,
      promo: makePromo({ targeting: { listings: { activeCategories: ['avto'] } } }),
    });
    expect(c.check(ctx, stats({ activeCategories: ['avto'] }))).toBe(false);
  });

  it('categories: passes when everCategories contains one of the required (any)', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { categories: ['avto', 'realty'] } } }),
    });
    expect(c.check(ctx, stats({ everCategories: ['realty'] }))).toBe(true);
    expect(c.check(ctx, stats({ everCategories: ['uslugi'] }))).toBe(false);
  });

  it('categories: categoriesMatch "all" requires every listed category', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { categories: ['avto', 'realty'], categoriesMatch: 'all' } } }),
    });
    expect(c.check(ctx, stats({ everCategories: ['avto', 'realty', 'uslugi'] }))).toBe(true);
    expect(c.check(ctx, stats({ everCategories: ['avto'] }))).toBe(false);
  });

  it('activeCategories: independent from categories (any by default)', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { activeCategories: ['avto'] } } }),
    });
    expect(c.check(ctx, stats({ activeCategories: ['avto'] }))).toBe(true);
    expect(c.check(ctx, stats({ everCategories: ['avto'], activeCategories: [] }))).toBe(false);
  });

  it('hasUnpromotedActive gate matches exactly', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { hasUnpromotedActive: true } } }),
    });
    expect(c.check(ctx, stats({ hasUnpromotedActive: true }))).toBe(true);
    expect(c.check(ctx, stats({ hasUnpromotedActive: false }))).toBe(false);
  });

  it('inactiveDays: passes when daysSinceLastListing is at least the threshold', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { inactiveDays: 30 } } }),
    });
    expect(c.check(ctx, stats({ daysSinceLastListing: 45 }))).toBe(true);
    expect(c.check(ctx, stats({ daysSinceLastListing: 10 }))).toBe(false);
  });

  it('inactiveDays: fails when the user has no listings at all (daysSinceLastListing undefined)', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { inactiveDays: 30 } } }),
    });
    expect(c.check(ctx, stats({ daysSinceLastListing: undefined }))).toBe(false);
  });

  it('combines multiple fields with AND', () => {
    const ctx = makeCheckContext({
      isAuthorized: true,
      promo: makePromo({ targeting: { listings: { activeCategories: ['avto'], hasUnpromotedActive: true } } }),
    });
    expect(c.check(ctx, stats({ activeCategories: ['avto'], hasUnpromotedActive: true }))).toBe(true);
    expect(c.check(ctx, stats({ activeCategories: ['avto'], hasUnpromotedActive: false }))).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npx vitest run src/promo-selector/checkers/registry/Listings.test.ts`
Expected: FAIL — `./Listings` не существует.

- [ ] **Step 3: Реализация**

Создать `src/promo-selector/checkers/registry/Listings.ts`:

```ts
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
```

- [ ] **Step 4: Убедиться, что проходит**

Run: `npx vitest run src/promo-selector/checkers/registry/Listings.test.ts`
Expected: PASS, все 13 тестов.

- [ ] **Step 5: Полный прогон и typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, чисто.

- [ ] **Step 6: Commit**

```bash
git add src/promo-selector/checkers/registry/Listings.ts src/promo-selector/checkers/registry/Listings.test.ts
git commit -m "feat(checkers): add ListingsChecker"
```

---

## Task 4: promo-bff — регистрация + `catalogue-schema.ts`

**Files:**
- Modify: `src/promo-selector/checkers/index.ts`
- Modify: `src/services/catalogue-schema.ts`
- Test: `src/services/catalogue-schema.test.ts`

**Interfaces:**
- Consumes: `ListingsChecker`, `hasListingsRule` (Task 3).
- Produces: `listings` зарегистрирован в `WEB_CHECKERS` и переживает
  `promoSchema.safeParse()` — конец promo-bff части плана.

- [ ] **Step 1: Регистрация в `WEB_CHECKERS`**

В `src/promo-selector/checkers/index.ts` добавить импорт:

```ts
import { ListingsChecker } from './registry/Listings';
```

В массиве `WEB_CHECKERS`, сразу после `new SellerChecker(),`:

```ts
  new SellerChecker(),
  new ListingsChecker(),
```

- [ ] **Step 2: Написать падающий тест на `catalogue-schema.ts`**

В `src/services/catalogue-schema.test.ts` найти существующий билдер
`makePromo(overrides)` (используется тестами `purchases`/`balance` round-trip,
добавленными фиксом ветки `feat/purchase-balance-checkers` — искать
`targeting.purchases` в описаниях тестов) — новые тесты используют тот же
билдер, добавить рядом:

```ts
it('does not strip targeting.listings (regression: silently-dropped-field bug)', () => {
  const promo = makePromo({
    targeting: {
      listings: {
        categories: ['avto'],
        categoriesMatch: 'all',
        activeCategories: ['avto'],
        hasUnpromotedActive: true,
        inactiveDays: 14,
      },
    },
  });
  const result = promoSchema.safeParse(promo);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.targeting.listings).toEqual({
      categories: ['avto'],
      categoriesMatch: 'all',
      activeCategories: ['avto'],
      hasUnpromotedActive: true,
      inactiveDays: 14,
    });
  }
});

it('rejects an out-of-range inactiveDays', () => {
  const promo = makePromo({ targeting: { listings: { inactiveDays: -1 } } });
  expect(promoSchema.safeParse(promo).success).toBe(false);
});
```

- [ ] **Step 3: Убедиться, что падает**

Run: `npx vitest run src/services/catalogue-schema.test.ts`
Expected: FAIL — `targeting.listings` вырезается (в `promoSchema.targeting`
такого поля ещё нет), `result.data.targeting.listings` будет `undefined`.

- [ ] **Step 4: Реализация**

В `src/services/catalogue-schema.ts`, сразу после блока
`balanceTargetingSchema` (добавленного соседней задачей на этой же ветке
кодовой базы — если его нет, добавить `listingsTargetingSchema` сразу после
`searchTargetingSchema`):

```ts
export const listingsTargetingSchema = z.object({
  categories: z.array(z.string().min(1)).optional(),
  categoriesMatch: z.enum(['any', 'all']).optional(),
  activeCategories: z.array(z.string().min(1)).optional(),
  hasUnpromotedActive: z.boolean().optional(),
  inactiveDays: z.number().int().nonnegative().optional(),
});
```

В `promoSchema`'s `targeting: z.object({...})`, сразу после
`search: searchTargetingSchema.optional(),` (или после `balance:
balanceTargetingSchema.optional(),`, если оно уже там — оба варианта
равнозначны, главное сохранить существующий порядок остальных полей):

```ts
    listings: listingsTargetingSchema.optional(),
```

- [ ] **Step 5: Убедиться, что проходит**

Run: `npx vitest run src/services/catalogue-schema.test.ts`
Expected: PASS.

- [ ] **Step 6: Полный прогон и typecheck**

Run: `npm test && npm run typecheck`
Expected: PASS, чисто.

- [ ] **Step 7: Commit**

```bash
git add src/promo-selector/checkers/index.ts src/services/catalogue-schema.ts src/services/catalogue-schema.test.ts
git commit -m "feat(checkers): register ListingsChecker, add listings to promoSchema.targeting"
```

**Конец promo-bff части. promo-cabinet часть (Tasks 5-7) не начинать, пока
`feat/purchase-balance-checkers` (promo-cabinet) не смержена в main.**

---

## Task 5: promo-cabinet — схема

**Files:**
- Modify: `src/lib/schema.ts`

**Interfaces:**
- Produces: `listingsTargetingSchema` — используется в Task 6, 7.

**Префлайт (перед первой правкой в этом репозитории):**

```bash
cd promo-cabinet
git fetch origin main
git switch -c feat/listings-targeting-checker origin/main
```

Убедиться перед этим, что `feat/purchase-balance-checkers` уже смержена в
`origin/main` (`git log origin/main --oneline | grep -i "purchase\|balance"`
должен что-то найти) — если нет, эта задача ждёт.

- [ ] **Step 1: Добавить схему**

В `src/lib/schema.ts`, сразу после блока `balanceTargetingSchema` (или
после `searchTargetingSchema`, если `purchases`/`balance` там ещё не
осели — оба места равнозначны):

```ts
export const listingsTargetingSchema = z.object({
  categories: z.array(z.string().min(1)).optional(),
  categoriesMatch: z.enum(['any', 'all']).optional(),
  activeCategories: z.array(z.string().min(1)).optional(),
  hasUnpromotedActive: z.boolean().optional(),
  inactiveDays: z.number().int().nonnegative('Число дней не может быть отрицательным').optional(),
});
```

- [ ] **Step 2: Подключить в `servingBlockSchema.targeting`**

В том же файле, в `servingBlockSchema`, в объекте `targeting: z.object({...})`,
сразу после `search: searchTargetingSchema.optional(),` (или после
`balance: balanceTargetingSchema.optional(),`, если оно уже там):

```ts
    listings: listingsTargetingSchema.optional(),
```

- [ ] **Step 3: Typecheck**

Run: `cd promo-cabinet && npm run typecheck`
Expected: PASS. Если падает из-за отсутствия доступа к приватному
npm-registry (`@zebrooo/promo-renderer`, `NODE_AUTH_TOKEN` не задан в
окружении) — известное ограничение среды, не блокер: проверить типы
вручную построчным чтением, реальная проверка — через CI на PR.

- [ ] **Step 4: Написать тест на новую схему**

Добавить в `src/lib/schema.test.ts`, рядом с `describe('balanceTargetingSchema'`:

```ts
describe('listingsTargetingSchema', () => {
  it('accepts an empty object', () => {
    expect(listingsTargetingSchema.safeParse({}).success).toBe(true);
  });
  it('accepts a fully specified rule', () => {
    const result = listingsTargetingSchema.safeParse({
      categories: ['avto', 'realty'],
      categoriesMatch: 'all',
      activeCategories: ['avto'],
      hasUnpromotedActive: true,
      inactiveDays: 14,
    });
    expect(result.success).toBe(true);
  });
  it('rejects an unknown categoriesMatch value', () => {
    expect(listingsTargetingSchema.safeParse({ categoriesMatch: 'both' }).success).toBe(false);
  });
  it('rejects a negative inactiveDays', () => {
    expect(listingsTargetingSchema.safeParse({ inactiveDays: -1 }).success).toBe(false);
  });
});
```

Добавить импорт `listingsTargetingSchema` в начало тестового файла, рядом с
существующими импортами `purchasesTargetingSchema`/`balanceTargetingSchema`.

- [ ] **Step 5: Запустить тесты**

Run: `npx vitest run src/lib/schema.test.ts`
Expected: PASS. Тот же известный npm-registry-гейт, что и в Step 3 — при
блокировке verify чтением, реальный прогон через CI.

- [ ] **Step 6: Commit**

```bash
git add src/lib/schema.ts src/lib/schema.test.ts
git commit -m "feat(schema): add listingsTargetingSchema"
```

---

## Task 6: promo-cabinet — очистка пустого блока в `to-persisted.ts`

**Files:**
- Modify: `src/components/promo-form/to-persisted.ts`
- Test: `src/components/promo-form/to-persisted.test.ts`

**Interfaces:**
- Consumes: `listingsTargetingSchema` не напрямую (форма `Promo['targeting']`
  уже расширена Task 5 через `servingBlockSchema`).

- [ ] **Step 1: Написать падающий тест**

В `src/components/promo-form/to-persisted.test.ts` есть локальный билдер
`make(format: Promo['format'], patch: Partial<Promo> = {}): Promo` (строка
~15) — используется всеми тестами в файле как `make('inline', {...})`.
Рядом с тестами на `purchases`/`balance` (или на `search`, если тех ещё нет
на этой ветке), добавить теми же билдером:

```ts
it('strips an empty listings block (no fields set → no criterion)', () => {
  const values = make('inline', { targeting: { listings: {} } });
  const result = toPersisted(values);
  expect(result.targeting.listings).toBeUndefined();
});

it('keeps a listings block with only hasUnpromotedActive:false set', () => {
  const values = make('inline', { targeting: { listings: { hasUnpromotedActive: false } } });
  const result = toPersisted(values);
  expect(result.targeting.listings).toEqual({ hasUnpromotedActive: false });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npx vitest run src/components/promo-form/to-persisted.test.ts`
Expected: FAIL — `normalize()` не трогает `targeting.listings`, пустой `{}`
останется как есть вместо превращения в `undefined`.

- [ ] **Step 3: Реализация**

В `src/components/promo-form/to-persisted.ts`, в функции `normalize()`,
сразу после блока `balance`/`purchases` (или после блока `search`, если
`purchases`/`balance` ещё не осели на этой ветке — новый блок должен идти
ПОСЛЕДНИМ перед `return { ...values, ... }`, работая с уже (возможно)
обновлённой переменной `targeting`, не заново с `values.targeting`):

```ts
  const listings = values.targeting.listings;
  const hasListingsCriteria = listings !== undefined && Object.keys(listings).length > 0;
  if (listings && !hasListingsCriteria) {
    const { listings: discardedListings, ...withoutListings } = targeting;
    void discardedListings;
    targeting = withoutListings;
  }
```

- [ ] **Step 4: Убедиться, что проходит**

Run: `npx vitest run src/components/promo-form/to-persisted.test.ts`
Expected: PASS. Тот же известный npm-registry-гейт (см. Task 5 Step 3) —
при блокировке verify чтением.

- [ ] **Step 5: Typecheck и commit**

```bash
npm run typecheck
git add src/components/promo-form/to-persisted.ts src/components/promo-form/to-persisted.test.ts
git commit -m "feat(form): strip empty listings targeting block on save"
```

---

## Task 7: promo-cabinet — UI-блок в `TargetingSection.tsx`

**Files:**
- Modify: `src/components/promo-form/sections/TargetingSection.tsx`

**Interfaces:**
- Consumes: `SlugListField` (`../fields`, уже импортирован в этом файле),
  `Promo['targeting']['listings']` (Task 5).

- [ ] **Step 1: Добавить блок**

В `src/components/promo-form/sections/TargetingSection.tsx`, внутри
`TargetingSection()`, после блока `<div className="ef-row">...Разделы/
Категории/По объявлениям...</div>` (тот, что содержит `<SlugListField
name="categories" .../>` и селект `sellerStatus`) и до блока `Аудитория`,
добавить:

```tsx
      <div className="ef-divider" />
      <div className="ef-label">Объявления продавца</div>
      <div className="ef-row">
        <div className="ef-field">
          <label>Категории (когда-либо размещал)</label>
          <SlugListField name="targeting.listings.categories" placeholder="avto, realty" />
        </div>
        <div className="ef-field">
          <label>Активные категории</label>
          <SlugListField name="targeting.listings.activeCategories" placeholder="avto" />
        </div>
        <div className="ef-field">
          <label>Совпадение категорий</label>
          <select
            className="ef-input"
            value={targeting.listings?.categoriesMatch ?? 'any'}
            onChange={(e) =>
              setFieldValue('targeting.listings', {
                ...targeting.listings,
                categoriesMatch: e.target.value as 'any' | 'all',
              })
            }
          >
            <option value="any">Хотя бы одна</option>
            <option value="all">Все</option>
          </select>
        </div>
      </div>
      <div className="ef-row">
        <div className="ef-field">
          <label>
            <input
              type="checkbox"
              checked={targeting.listings?.hasUnpromotedActive ?? false}
              onChange={(e) =>
                setFieldValue('targeting.listings', {
                  ...targeting.listings,
                  hasUnpromotedActive: e.target.checked ? true : undefined,
                })
              }
            />
            {' '}Есть активное объявление без продвижения
          </label>
        </div>
        <div className="ef-field">
          <label>Не размещал ≥ дней</label>
          <input
            type="number"
            className="ef-input mono"
            min={0}
            value={targeting.listings?.inactiveDays ?? ''}
            onChange={(e) =>
              setFieldValue('targeting.listings', {
                ...targeting.listings,
                inactiveDays: e.target.value === '' ? undefined : Number(e.target.value),
              })
            }
            placeholder="—"
          />
          <FieldError name="targeting.listings.inactiveDays" />
        </div>
      </div>
      <span className="ef-hint">
        Пустой блок — фильтр по объявлениям продавца выключен. `SlugListField`
        сам превращает пустой ввод в `undefined` — очистка при сохранении
        (Task 6) довершает дело для оставшихся пустых объектов.
      </span>
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS (тот же известный npm-registry-гейт — при блокировке verify
построчным чтением JSX против пропсов `SlugListField`/`FieldError`).

- [ ] **Step 3: Ручная проверка в браузере**

Открыть форму промо в кабинете (dev-сервер), перейти на вкладку таргетинга,
убедиться, что блок «Объявления продавца» рендерится, поля редактируются,
сохранение не роняет форму. (Если dev-сервер поднять негде в этой среде —
пропустить, полагаться на CI + ручную проверку владельца после деплоя на
стенд.)

- [ ] **Step 4: Commit**

```bash
git add src/components/promo-form/sections/TargetingSection.tsx
git commit -m "feat(form): add listings targeting UI block"
```
