# Чекеры «Покупки пакетов» и «Кошелёк» — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Добавить два новых чекера в promo-selector (`PurchaseChecker`, `BalanceChecker`), позволяющих таргетировать промо по истории покупок VIP/premium/bump-пакетов и по остатку/движению кошелька посетителя-продавца, плюс соответствующую форму в promo-cabinet.

**Architecture:** Тот же паттерн, что у `SearchChecker` (promo-bff #13): новый read-only сервис читает данные из Supabase abkhaz-auto (service-role REST, таблицы `ledger_accounts`/`ledger_postings`/`ledger_transactions`), данные грузятся ОДИН раз на весь walk отбора и кладутся в `CheckContext`, чекеры читают контекст синхронно. В promo-cabinet — два новых блока в существующей `TargetingSection.tsx`.

**Tech Stack:** TypeScript, Fastify (promo-bff), Next.js + Formik + Zod (promo-cabinet), Vitest везде.

## Упрощение относительно спеки

Спека (`docs/superpowers/specs/2026-08-13-purchase-balance-checkers-design.md`)
описывала один сервис с двумя методами, потенциально шарящими один HTTP-запрос.
В плане это два независимых метода `getPurchases`/`getMovement`, каждый со
своим запросом — проще, тестируется отдельно, соответствует стилю
`balance-service.ts` (там тоже нет попыток шарить запросы между вызовами).
Цена — до двух round-trip'ов вместо одного при использовании обоих чекеров
одновременно; при таймауте 300мс и локальной БД это не критично, а спека сама
отмечает, что кэш здесь избыточен на этом масштабе.

## Global Constraints

- Оба чекера обязаны провалиться (`check()` → `false`), а не пройти по
  умолчанию, если `ctx.isAuthorized === false` и правило задано хоть одним
  полем — данные привязаны к `ledger_accounts.owner_user_id`, у анонима его нет.
- `shouldSkip()` — только по «правило не задано», не по авторизации (skip ==
  eligible, это НЕ то же самое, что «нет данных»).
- Суммы в БД — kopecks (integer), в UI promo-cabinet — рубли; конвертация
  только на границе `TargetingSection.tsx`/`schema.ts`.
- Таймаут сервиса — 300мс (тот же бюджет, что у `search-history-service.ts`).
- Тесты пишутся ДО реализации на каждом шаге (TDD), запускаются и проверяются
  до и после написания кода.

---

## Файловая структура

**promo-bff (репозиторий `Zebrooo/promo-bff`, ветка `feat/purchase-balance-checkers` уже создана, спека уже закоммичена в неё):**

| Файл | Что делает |
|---|---|
| `src/promo-selector/types.ts` | + `targeting.purchases`, `targeting.balance` в `PromoTargeting` |
| `src/promo-selector/checkers/Checker.ts` | + `PurchaseEntry`, + 3 поля `CheckContext` |
| `src/services/purchase-ledger-service.ts` (новый) | `getPurchases`/`getMovement` — REST-чтение `ledger_*` |
| `src/promo-selector/checkers/registry/Purchases.ts` (новый) | `PurchaseChecker` |
| `src/promo-selector/checkers/registry/Balance.ts` (новый) | `BalanceChecker` |
| `src/promo-selector/checkers/index.ts` | регистрация обоих в `WEB_CHECKERS`, реэкспорт типов |
| `src/models/select-promo/handle.ts` | `loadWalletDataForSelection()`, деп `purchaseLedgerService`+`balanceService` в `SelectPromoDeps`, вызов в `handleSelectPromo` |
| `src/models/select-promo/handle-list.ts` | тот же вызов в `handleSelectPromoList` |
| `src/server.ts` | добавить `purchaseLedgerService`/`balanceService` в конструктор `deps: SelectPromoDeps` |

**promo-cabinet (репозиторий `Zebrooo/promo-cabinet`, новая ветка `feat/purchase-balance-checkers`):**

| Файл | Что делает |
|---|---|
| `src/lib/schema.ts` | + `purchasesTargetingSchema`, `balanceTargetingSchema` |
| `src/components/promo-form/to-persisted.ts` | strip пустых блоков в `normalize()` |
| `src/components/promo-form/sections/TargetingSection.tsx` | два новых блока UI |

---

### Task 1: `PromoTargeting` — новые поля

**Files:**
- Modify: `src/promo-selector/types.ts`

**Interfaces:**
- Produces: `PromoTargeting.purchases`, `PromoTargeting.balance` — читаются задачами 4, 5.

- [ ] **Step 1: Добавить поля в `PromoTargeting`**

В `src/promo-selector/types.ts`, сразу после блока `search?: {...}` (перед закрывающей `}` интерфейса `PromoTargeting`):

```ts
  /** Purchase-history gate (VIP/premium/bump packs). Omitted/empty means no gate. */
  purchases?: {
    /** true = must have purchased; false = must NOT have purchased in the window. */
    purchased?: boolean;
    minTotalKopecks?: number;
    maxTotalKopecks?: number;
    minCount?: number;
    maxCount?: number;
    /** Restrict to these pack kinds; omitted/empty = any kind. */
    packTypes?: ('bump' | 'premium' | 'vip')[];
    /** Rolling window. Defaults to 30 days. */
    lookbackDays?: number;
  };
  /** Wallet balance/movement gate. Omitted/empty means no gate. */
  balance?: {
    currentAbove?: number;
    currentBelow?: number;
    movementAbove?: number;
    movementBelow?: number;
    /** Window for movement checks. Omitted = all-time (since account creation). */
    movementLookbackDays?: number;
  };
```

- [ ] **Step 2: Typecheck**

Run: `cd promo-bff && npm run typecheck`
Expected: PASS (только добавили опциональные поля, ничего не сломано).

- [ ] **Step 3: Commit**

```bash
git add src/promo-selector/types.ts
git commit -m "feat(types): add targeting.purchases and targeting.balance"
```

---

### Task 2: `CheckContext` — новые поля и `PurchaseEntry`

**Files:**
- Modify: `src/promo-selector/checkers/Checker.ts`

**Interfaces:**
- Consumes: ничего нового.
- Produces: `PurchaseEntry` (используется в Task 3, 4), `CheckContext.purchases`/`.walletBalanceKopecks`/`.walletMovementKopecks` (используются в Task 4, 5, 7).

- [ ] **Step 1: Добавить `PurchaseEntry` рядом с `SearchHistoryEntry`**

В `src/promo-selector/checkers/Checker.ts`, сразу после интерфейса `SearchHistoryEntry`:

```ts
export interface PurchaseEntry {
  pack: 'bump' | 'premium' | 'vip';
  /** Всегда положительное число (модуль списания), kopecks. */
  amountKopecks: number;
  createdAt: string;
}
```

- [ ] **Step 2: Расширить `CheckContext`**

В том же файле, в интерфейсе `CheckContext`, сразу после поля `searchHistory?: SearchHistoryEntry[];`:

```ts
  /** Покупки пакетов, преднагруженные на максимальное lookbackDays среди
   *  промо в очереди. Каждый чекер сам фильтрует по своему окну. */
  purchases?: PurchaseEntry[];
  /** Текущий остаток кошелька, kopecks. undefined = нет счёта/не загружали. */
  walletBalanceKopecks?: number;
  /** Сумма движения по кошельку за окно, запрошенное чекерами очереди. */
  walletMovementKopecks?: number;
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/promo-selector/checkers/Checker.ts
git commit -m "feat(checkers): add PurchaseEntry and wallet fields to CheckContext"
```

---

### Task 3: `purchase-ledger-service.ts`

**Files:**
- Create: `src/services/purchase-ledger-service.ts`
- Test: `src/services/purchase-ledger-service.test.ts`

**Interfaces:**
- Consumes: `config.aaSupabase` (`src/config.ts`, уже существует), `withTimeout` (`src/util/with-timeout.ts`, уже существует), `PurchaseEntry` (Task 2).
- Produces: `PurchaseLedgerService` — `getPurchases(userId, sinceMs?)`, `getMovement(userId, sinceMs?)`. Используется в Task 7.

- [ ] **Step 1: Написать падающий тест**

Создать `src/services/purchase-ledger-service.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPurchaseLedgerService } from './purchase-ledger-service';

const cfg = { url: 'https://db.example', serviceRoleKey: 'k', timeoutMs: 2000 };

afterEach(() => vi.restoreAllMocks());

function mockFetchSequence(responses: Array<{ status: number; body: unknown }>) {
  let i = 0;
  const fn = vi.fn(async () => {
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.body } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('createPurchaseLedgerService.getPurchases', () => {
  it('looks up the account then reads charge/listing postings with pack in meta', async () => {
    const fn = mockFetchSequence([
      { status: 200, body: [{ id: 42 }] },
      {
        status: 200,
        body: [
          { amount_kopecks: -49000, created_at: '2026-08-01T00:00:00Z', ledger_transactions: { type: 'charge', subject_kind: 'listing', meta: { pack: 'premium' } } },
          { amount_kopecks: -14900, created_at: '2026-08-05T00:00:00Z', ledger_transactions: { type: 'charge', subject_kind: 'listing', meta: { pack: 'bump' } } },
        ],
      },
    ]);
    const out = await createPurchaseLedgerService(cfg).getPurchases('user-1');
    expect(out).toEqual([
      { pack: 'premium', amountKopecks: 49000, createdAt: '2026-08-01T00:00:00Z' },
      { pack: 'bump', amountKopecks: 14900, createdAt: '2026-08-05T00:00:00Z' },
    ]);
    const accountUrl = (fn.mock.calls[0] as unknown as [string])[0];
    expect(accountUrl).toContain('/rest/v1/ledger_accounts');
    expect(accountUrl).toContain('owner_user_id=eq.user-1');
    expect(accountUrl).toContain('kind=eq.liability');
    const postingsUrl = (fn.mock.calls[1] as unknown as [string])[0];
    expect(postingsUrl).toContain('/rest/v1/ledger_postings');
    expect(postingsUrl).toContain('account_id=eq.42');
    expect(postingsUrl).toContain('ledger_transactions.type=eq.charge');
    expect(postingsUrl).toContain('ledger_transactions.subject_kind=eq.listing');
  });

  it('applies the sinceMs cutoff when given', async () => {
    const fn = mockFetchSequence([{ status: 200, body: [{ id: 1 }] }, { status: 200, body: [] }]);
    await createPurchaseLedgerService(cfg).getPurchases('user-1', Date.parse('2026-08-01T00:00:00Z'));
    const postingsUrl = (fn.mock.calls[1] as unknown as [string])[0];
    expect(postingsUrl).toContain('created_at=gte.2026-08-01T00%3A00%3A00.000Z');
  });

  it('drops rows with an unknown pack value and non-listing/non-charge rows', async () => {
    mockFetchSequence([
      { status: 200, body: [{ id: 1 }] },
      {
        status: 200,
        body: [
          { amount_kopecks: -1, created_at: '2026-08-01T00:00:00Z', ledger_transactions: { type: 'charge', subject_kind: 'listing', meta: { pack: 'unknown' } } },
        ],
      },
    ]);
    const out = await createPurchaseLedgerService(cfg).getPurchases('user-1');
    expect(out).toEqual([]);
  });

  it('returns an empty array when the user has no wallet account', async () => {
    const fn = mockFetchSequence([{ status: 200, body: [] }]);
    const out = await createPurchaseLedgerService(cfg).getPurchases('user-1');
    expect(out).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1); // не делает второй запрос без account id
  });

  it('returns an empty array when unconfigured (no query)', async () => {
    const fn = vi.fn();
    vi.stubGlobal('fetch', fn);
    const out = await createPurchaseLedgerService({ url: '', serviceRoleKey: '', timeoutMs: 2000 }).getPurchases('user-1');
    expect(out).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createPurchaseLedgerService.getMovement', () => {
  it('sums all postings for the account (no type/subject filter)', async () => {
    const fn = mockFetchSequence([
      { status: 200, body: [{ id: 42 }] },
      { status: 200, body: [{ amount_kopecks: 100000 }, { amount_kopecks: -49000 }] },
    ]);
    const out = await createPurchaseLedgerService(cfg).getMovement('user-1');
    expect(out).toBe(51000);
    const postingsUrl = (fn.mock.calls[1] as unknown as [string])[0];
    expect(postingsUrl).toContain('/rest/v1/ledger_postings');
    expect(postingsUrl).toContain('account_id=eq.42');
    expect(postingsUrl).not.toContain('ledger_transactions');
  });

  it('returns 0 when the user has no wallet account', async () => {
    mockFetchSequence([{ status: 200, body: [] }]);
    expect(await createPurchaseLedgerService(cfg).getMovement('user-1')).toBe(0);
  });
});
```

- [ ] **Step 2: Запустить и убедиться, что падает**

Run: `npx vitest run src/services/purchase-ledger-service.test.ts`
Expected: FAIL — `Cannot find module './purchase-ledger-service'`.

- [ ] **Step 3: Реализация**

Создать `src/services/purchase-ledger-service.ts`:

```ts
/**
 * Ledger reader for the two behavioural checkers (Purchases, Balance): pack
 * purchases and net wallet movement, both derived from `ledger_postings` on
 * the abkhaz-auto Supabase (0041_wallet_ledger.sql). Wallet CURRENT balance
 * is a separate concern — see `balance-service.ts` (denormalized column,
 * no ledger read needed); this service only reads the append-only journal.
 */
import { config, type SupabaseConfig } from '../config';
import type { PurchaseEntry } from '../promo-selector/checkers/Checker';
import { withTimeout } from '../util/with-timeout';

const TIMEOUT_MS = 300;
const KNOWN_PACKS = new Set(['bump', 'premium', 'vip']);

export interface PurchaseLedgerService {
  getPurchases(userId: string, sinceMs?: number): Promise<PurchaseEntry[]>;
  getMovement(userId: string, sinceMs?: number): Promise<number>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function findAccountId(
  base: string,
  key: string,
  userId: string,
  controller: AbortController,
): Promise<number | null> {
  const params = new URLSearchParams({
    owner_user_id: `eq.${userId}`,
    kind: 'eq.liability',
    select: 'id',
  });
  const res = await fetch(`${base}/rest/v1/ledger_accounts?${params}`, {
    headers: authHeaders(key),
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`purchase-ledger-service account lookup failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

interface PurchaseRow {
  amount_kopecks: number | string;
  created_at: string;
  ledger_transactions: { type: string; subject_kind: string; meta: Record<string, unknown> | null };
}

function parsePurchaseRow(row: PurchaseRow): PurchaseEntry | null {
  const pack = row.ledger_transactions?.meta?.pack;
  if (typeof pack !== 'string' || !KNOWN_PACKS.has(pack)) return null;
  return {
    pack: pack as PurchaseEntry['pack'],
    amountKopecks: Math.abs(Number(row.amount_kopecks)),
    createdAt: row.created_at,
  };
}

export function createPurchaseLedgerService(cfg: SupabaseConfig = config.aaSupabase): PurchaseLedgerService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getPurchases: async () => [], getMovement: async () => 0 };
  }
  const budget = Math.min(timeoutMs, TIMEOUT_MS);

  async function getPurchases(userId: string, sinceMs?: number): Promise<PurchaseEntry[]> {
    const controller = new AbortController();
    const accountId = await findAccountId(url, serviceRoleKey, userId, controller);
    if (accountId === null) return [];
    const params = new URLSearchParams({
      select: 'amount_kopecks,created_at,ledger_transactions!inner(type,subject_kind,meta)',
      account_id: `eq.${accountId}`,
      'ledger_transactions.type': 'eq.charge',
      'ledger_transactions.subject_kind': 'eq.listing',
    });
    if (sinceMs !== undefined) params.append('created_at', `gte.${new Date(sinceMs).toISOString()}`);
    const res = await fetch(`${url}/rest/v1/ledger_postings?${params}`, {
      headers: authHeaders(serviceRoleKey),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`purchase-ledger-service purchases read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as PurchaseRow[];
    return rows.flatMap((row) => {
      const parsed = parsePurchaseRow(row);
      return parsed ? [parsed] : [];
    });
  }

  async function getMovement(userId: string, sinceMs?: number): Promise<number> {
    const controller = new AbortController();
    const accountId = await findAccountId(url, serviceRoleKey, userId, controller);
    if (accountId === null) return 0;
    const params = new URLSearchParams({
      select: 'amount_kopecks',
      account_id: `eq.${accountId}`,
    });
    if (sinceMs !== undefined) params.append('created_at', `gte.${new Date(sinceMs).toISOString()}`);
    const res = await fetch(`${url}/rest/v1/ledger_postings?${params}`, {
      headers: authHeaders(serviceRoleKey),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`purchase-ledger-service movement read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ amount_kopecks: number | string }>;
    return rows.reduce((sum, r) => sum + Number(r.amount_kopecks), 0);
  }

  return {
    getPurchases: (userId, sinceMs) => withTimeout(getPurchases(userId, sinceMs), budget, 'purchaseLedgerService.getPurchases'),
    getMovement: (userId, sinceMs) => withTimeout(getMovement(userId, sinceMs), budget, 'purchaseLedgerService.getMovement'),
  };
}
```

- [ ] **Step 4: Запустить и убедиться, что проходит**

Run: `npx vitest run src/services/purchase-ledger-service.test.ts`
Expected: PASS, все 7 тестов.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/purchase-ledger-service.ts src/services/purchase-ledger-service.test.ts
git commit -m "feat(services): add purchase-ledger-service (pack purchases + wallet movement)"
```

---

### Task 4: `PurchaseChecker`

**Files:**
- Create: `src/promo-selector/checkers/registry/Purchases.ts`
- Test: `src/promo-selector/checkers/registry/Purchases.test.ts`

**Interfaces:**
- Consumes: `Checker`, `CheckContext`, `PurchaseEntry` (Task 2); `makeCheckContext`, `makePromo` (`src/test-utils.ts`, уже существуют).
- Produces: `PurchaseChecker`, `hasPurchaseRule` — используются в Task 6 (регистрация) и Task 7 (косвенно, через `shouldSkip`).

- [ ] **Step 1: Написать падающий тест**

Создать `src/promo-selector/checkers/registry/Purchases.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { PurchaseChecker } from './Purchases';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new PurchaseChecker();
const now = new Date('2026-08-13T12:00:00.000Z');
const entry = (pack: 'bump' | 'premium' | 'vip', amountKopecks: number, createdAt = '2026-08-10T00:00:00.000Z') => ({
  pack,
  amountKopecks,
  createdAt,
});

function context(
  purchases: NonNullable<ReturnType<typeof makePromo>['targeting']['purchases']>,
  entries = [entry('vip', 69000)],
  isAuthorized = true,
) {
  return makeCheckContext({
    promo: makePromo({ targeting: { purchases } }),
    isAuthorized,
    now,
    purchases: entries,
  });
}

describe('PurchaseChecker', () => {
  it('skips when no rule is configured', () => {
    expect(checker.shouldSkip(makeCheckContext())).toBe('no purchase targeting');
    expect(checker.shouldSkip(context({}))).toBe(false); // {} — валидный, но пустой объект всё ещё "задан"
  });

  it('fails closed for an unauthorized viewer even with matching purchases', () => {
    expect(checker.check(context({ purchased: true }, [entry('vip', 69000)], false))).toBe(false);
  });

  it('purchased:true requires at least one qualifying purchase in the window', () => {
    expect(checker.check(context({ purchased: true }, []))).toBe(false);
    expect(checker.check(context({ purchased: true }, [entry('bump', 14900)]))).toBe(true);
  });

  it('purchased:false requires zero purchases in the window', () => {
    expect(checker.check(context({ purchased: false }, []))).toBe(true);
    expect(checker.check(context({ purchased: false }, [entry('bump', 14900)]))).toBe(false);
  });

  it('filters by packTypes before applying other conditions', () => {
    const rule = { packTypes: ['vip' as const], minCount: 1 };
    expect(checker.check(context(rule, [entry('bump', 14900)]))).toBe(false);
    expect(checker.check(context(rule, [entry('vip', 69000)]))).toBe(true);
  });

  it('enforces minCount/maxCount over the qualifying purchases', () => {
    const three = [entry('bump', 14900), entry('bump', 14900), entry('bump', 14900)];
    expect(checker.check(context({ minCount: 3 }, three))).toBe(true);
    expect(checker.check(context({ minCount: 4 }, three))).toBe(false);
    expect(checker.check(context({ maxCount: 2 }, three))).toBe(false);
  });

  it('enforces minTotalKopecks/maxTotalKopecks over the sum of qualifying purchases', () => {
    const two = [entry('vip', 69000), entry('premium', 49000)];
    expect(checker.check(context({ minTotalKopecks: 100000 }, two))).toBe(true);
    expect(checker.check(context({ minTotalKopecks: 200000 }, two))).toBe(false);
    expect(checker.check(context({ maxTotalKopecks: 100000 }, two))).toBe(false);
  });

  it('honours the configured lookback window (default 30 days)', () => {
    const old = entry('vip', 69000, '2026-07-01T00:00:00.000Z');
    expect(checker.check(context({ minCount: 1 }, [old]))).toBe(false); // > 30 дней от now
    expect(checker.check(context({ minCount: 1, lookbackDays: 60 }, [old]))).toBe(true);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npx vitest run src/promo-selector/checkers/registry/Purchases.test.ts`
Expected: FAIL — модуль не найден.

- [ ] **Step 3: Реализация**

Создать `src/promo-selector/checkers/registry/Purchases.ts`:

```ts
import { Checker, type CheckContext, type PurchaseEntry } from '../Checker';
import type { Promo } from '../../types';

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_LOOKBACK_DAYS = 30;

export function hasPurchaseRule(promo: Promo): boolean {
  return promo.targeting.purchases !== undefined;
}

function inWindow(entries: PurchaseEntry[], now: Date, lookbackDays: number): PurchaseEntry[] {
  const cutoffMs = now.getTime() - lookbackDays * DAY_MS;
  return entries.filter((e) => {
    const createdMs = Date.parse(e.createdAt);
    return Number.isFinite(createdMs) && createdMs >= cutoffMs && createdMs <= now.getTime();
  });
}

/** Gates promos by the request viewer's pack-purchase history (bump/premium/vip). */
export class PurchaseChecker extends Checker {
  readonly name = 'purchases';

  expect() {
    return "viewer's pack purchase history matches the promo's purchase targeting";
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasPurchaseRule(ctx.promo) ? false : 'no purchase targeting';
  }

  // isAuthorized-гейт — здесь, не в shouldSkip: неавторизованный обязан
  // ПРОВАЛИТЬ правило (false), а не пройти как "не применимо" (skip == eligible).
  check(ctx: CheckContext): boolean {
    if (!ctx.isAuthorized) return false;
    const rule = ctx.promo.targeting.purchases!;
    const lookbackDays = rule.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const windowed = inWindow(ctx.purchases ?? [], ctx.now, lookbackDays);
    const filtered = rule.packTypes?.length
      ? windowed.filter((e) => rule.packTypes!.includes(e.pack))
      : windowed;

    if (rule.purchased === false && filtered.length > 0) return false;
    if (rule.purchased === true && filtered.length === 0) return false;
    if (rule.minCount !== undefined && filtered.length < rule.minCount) return false;
    if (rule.maxCount !== undefined && filtered.length > rule.maxCount) return false;

    const total = filtered.reduce((sum, e) => sum + e.amountKopecks, 0);
    if (rule.minTotalKopecks !== undefined && total < rule.minTotalKopecks) return false;
    if (rule.maxTotalKopecks !== undefined && total > rule.maxTotalKopecks) return false;

    return true;
  }
}
```

- [ ] **Step 4: Убедиться, что проходит**

Run: `npx vitest run src/promo-selector/checkers/registry/Purchases.test.ts`
Expected: PASS, все 9 тестов.

- [ ] **Step 5: Typecheck и commit**

```bash
npm run typecheck
git add src/promo-selector/checkers/registry/Purchases.ts src/promo-selector/checkers/registry/Purchases.test.ts
git commit -m "feat(checkers): add PurchaseChecker"
```

---

### Task 5: `BalanceChecker`

**Files:**
- Create: `src/promo-selector/checkers/registry/Balance.ts`
- Test: `src/promo-selector/checkers/registry/Balance.test.ts`

**Interfaces:**
- Consumes: `Checker`, `CheckContext` (Task 2).
- Produces: `BalanceChecker`, `hasBalanceRule` — используются в Task 6, 7.

- [ ] **Step 1: Написать падающий тест**

Создать `src/promo-selector/checkers/registry/Balance.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { BalanceChecker } from './Balance';
import { makeCheckContext, makePromo } from '../../../test-utils';

const checker = new BalanceChecker();

function context(
  balance: NonNullable<ReturnType<typeof makePromo>['targeting']['balance']>,
  overrides: { walletBalanceKopecks?: number; walletMovementKopecks?: number; isAuthorized?: boolean } = {},
) {
  return makeCheckContext({
    promo: makePromo({ targeting: { balance } }),
    isAuthorized: overrides.isAuthorized ?? true,
    walletBalanceKopecks: overrides.walletBalanceKopecks,
    walletMovementKopecks: overrides.walletMovementKopecks,
  });
}

describe('BalanceChecker', () => {
  it('skips when no rule is configured', () => {
    expect(checker.shouldSkip(makeCheckContext())).toBe('no balance targeting');
    expect(checker.shouldSkip(context({}))).toBe(false);
  });

  it('fails closed for an unauthorized viewer', () => {
    expect(checker.check(context({ currentAbove: 0 }, { walletBalanceKopecks: 100000, isAuthorized: false }))).toBe(false);
  });

  it('enforces currentAbove/currentBelow against walletBalanceKopecks', () => {
    expect(checker.check(context({ currentAbove: 50000 }, { walletBalanceKopecks: 100000 }))).toBe(true);
    expect(checker.check(context({ currentAbove: 150000 }, { walletBalanceKopecks: 100000 }))).toBe(false);
    expect(checker.check(context({ currentBelow: 50000 }, { walletBalanceKopecks: 30000 }))).toBe(true);
    expect(checker.check(context({ currentBelow: 50000 }, { walletBalanceKopecks: 100000 }))).toBe(false);
  });

  it('treats a missing walletBalanceKopecks as 0', () => {
    expect(checker.check(context({ currentAbove: 1 }))).toBe(false);
    expect(checker.check(context({ currentBelow: 1 }))).toBe(true);
  });

  it('enforces movementAbove/movementBelow against walletMovementKopecks independently of current balance', () => {
    expect(checker.check(context({ movementAbove: 50000 }, { walletMovementKopecks: 100000 }))).toBe(true);
    expect(checker.check(context({ movementAbove: 150000 }, { walletMovementKopecks: 100000 }))).toBe(false);
    expect(checker.check(context({ movementBelow: -10000 }, { walletMovementKopecks: -50000 }))).toBe(true);
  });

  it('combines current and movement conditions with AND', () => {
    const rule = { currentAbove: 10000, movementBelow: 0 };
    expect(checker.check(context(rule, { walletBalanceKopecks: 20000, walletMovementKopecks: -5000 }))).toBe(true);
    expect(checker.check(context(rule, { walletBalanceKopecks: 5000, walletMovementKopecks: -5000 }))).toBe(false);
    expect(checker.check(context(rule, { walletBalanceKopecks: 20000, walletMovementKopecks: 5000 }))).toBe(false);
  });
});
```

- [ ] **Step 2: Убедиться, что падает**

Run: `npx vitest run src/promo-selector/checkers/registry/Balance.test.ts`
Expected: FAIL.

- [ ] **Step 3: Реализация**

Создать `src/promo-selector/checkers/registry/Balance.ts`:

```ts
import { Checker, type CheckContext } from '../Checker';
import type { Promo } from '../../types';

export function hasBalanceRule(promo: Promo): boolean {
  return promo.targeting.balance !== undefined;
}

/** Gates promos by the request viewer's wallet balance / recent movement. */
export class BalanceChecker extends Checker {
  readonly name = 'balance';

  expect() {
    return "viewer's wallet balance/movement matches the promo's balance targeting";
  }

  shouldSkip(ctx: CheckContext): false | string {
    return hasBalanceRule(ctx.promo) ? false : 'no balance targeting';
  }

  check(ctx: CheckContext): boolean {
    if (!ctx.isAuthorized) return false;
    const rule = ctx.promo.targeting.balance!;
    const current = ctx.walletBalanceKopecks ?? 0;
    const movement = ctx.walletMovementKopecks ?? 0;

    if (rule.currentAbove !== undefined && current < rule.currentAbove) return false;
    if (rule.currentBelow !== undefined && current > rule.currentBelow) return false;
    if (rule.movementAbove !== undefined && movement < rule.movementAbove) return false;
    if (rule.movementBelow !== undefined && movement > rule.movementBelow) return false;

    return true;
  }
}
```

- [ ] **Step 4: Убедиться, что проходит**

Run: `npx vitest run src/promo-selector/checkers/registry/Balance.test.ts`
Expected: PASS, все 7 тестов.

- [ ] **Step 5: Typecheck и commit**

```bash
npm run typecheck
git add src/promo-selector/checkers/registry/Balance.ts src/promo-selector/checkers/registry/Balance.test.ts
git commit -m "feat(checkers): add BalanceChecker"
```

---

### Task 6: Регистрация в `WEB_CHECKERS`

**Files:**
- Modify: `src/promo-selector/checkers/index.ts`

**Interfaces:**
- Consumes: `PurchaseChecker` (Task 4), `BalanceChecker` (Task 5).

- [ ] **Step 1: Импорт и регистрация**

В `src/promo-selector/checkers/index.ts` добавить импорты после `SearchChecker`:

```ts
import { PurchaseChecker } from './registry/Purchases';
import { BalanceChecker } from './registry/Balance';
```

И в массиве `WEB_CHECKERS`, сразу после `new SearchChecker(),`:

```ts
  new PurchaseChecker(),
  new BalanceChecker(),
```

Также добавить в реэкспорт типов (рядом с `export type { SearchHistoryEntry }`):

```ts
export type { PurchaseEntry } from './Checker';
```

- [ ] **Step 2: Проверить существующий тест на порядок чекеров, если есть**

Run: `grep -rn "WEB_CHECKERS" src/ --include=*.test.ts`

Если находится тест, проверяющий точный состав/длину `WEB_CHECKERS` (например в `server.test.ts`) — обновить ожидаемый список, добавив `'purchases'` и `'balance'` в нужную позицию (после `'search'`).

- [ ] **Step 3: Запустить полный набор тестов**

Run: `npm test`
Expected: PASS (включая обновлённый тест из Step 2, если он был).

- [ ] **Step 4: Typecheck и commit**

```bash
npm run typecheck
git add src/promo-selector/checkers/index.ts
git commit -m "feat(checkers): register PurchaseChecker and BalanceChecker in WEB_CHECKERS"
```

---

### Task 7: Загрузка данных в `handle.ts`/`handle-list.ts` + деп в `server.ts`

**Files:**
- Modify: `src/models/select-promo/handle.ts`
- Modify: `src/models/select-promo/handle-list.ts`
- Modify: `src/server.ts`

**Interfaces:**
- Consumes: `createPurchaseLedgerService`, `PurchaseLedgerService` (Task 3); `createBalanceService`, `BalanceService` (уже существует, `src/services/balance-service.ts`); `hasPurchaseRule` (Task 4); `hasBalanceRule` (Task 5).
- Produces: `loadWalletDataForSelection()` — используется обоими handler'ами. `SelectPromoDeps.purchaseLedgerService`/`.balanceService` — читаются `server.ts`.

- [ ] **Step 1: Расширить `SelectPromoDeps` и добавить загрузчик в `handle.ts`**

В `src/models/select-promo/handle.ts` — импорты (добавить к существующим):

```ts
import type { PurchaseLedgerService } from '../../services/purchase-ledger-service';
import type { BalanceService } from '../../services/balance-service';
import { hasPurchaseRule } from '../../promo-selector/checkers/registry/Purchases';
import { hasBalanceRule } from '../../promo-selector/checkers/registry/Balance';
```

В интерфейс `SelectPromoDeps`, сразу после `searchHistoryService: SearchHistoryService;`:

```ts
  purchaseLedgerService: PurchaseLedgerService;
  balanceService: BalanceService;
```

Новая функция, сразу после `loadSearchHistoryForSelection` (тот же файл):

```ts
/**
 * Loads wallet data (purchases + current balance + movement) only when this
 * walk can actually evaluate a purchases/balance rule — same short-circuit
 * shape as loadSearchHistoryForSelection. Three independent reads run in
 * parallel; a failure in any one degrades that piece to "no data" (checker
 * then fails closed) without blocking the other two or the rest of selection.
 */
export async function loadWalletDataForSelection(
  params: SelectPromoParams,
  promos: Promo[],
  skip: string[],
  deps: SelectPromoDeps,
  logPrefix: 'select-promo' | 'select-promo-list',
): Promise<{ purchases: PurchaseEntry[]; walletBalanceKopecks?: number; walletMovementKopecks?: number }> {
  const empty = { purchases: [], walletBalanceKopecks: undefined, walletMovementKopecks: undefined };
  if (!params.userId) return empty;

  const needsPurchases = !skip.includes('purchases') && promos.some(hasPurchaseRule);
  const needsBalance = !skip.includes('balance') && promos.some(hasBalanceRule);
  if (!needsPurchases && !needsBalance) return empty;

  const purchaseLookbackDays = needsPurchases
    ? Math.max(...promos.filter(hasPurchaseRule).map((p) => p.targeting.purchases!.lookbackDays ?? 30))
    : 0;
  const movementLookbackDays = needsBalance
    ? promos
        .filter((p) => hasBalanceRule(p) && p.targeting.balance!.movementLookbackDays !== undefined)
        .reduce<number | undefined>((max, p) => {
          const d = p.targeting.balance!.movementLookbackDays!;
          return max === undefined ? d : Math.max(max, d);
        }, undefined)
    : undefined;
  const movementSinceMs = movementLookbackDays !== undefined
    ? Date.now() - movementLookbackDays * 24 * 60 * 60 * 1000
    : undefined;
  const needsCurrentBalance = needsBalance && promos.some(
    (p) => hasBalanceRule(p) && (p.targeting.balance!.currentAbove !== undefined || p.targeting.balance!.currentBelow !== undefined),
  );
  const needsMovement = needsBalance && promos.some(
    (p) => hasBalanceRule(p) && (p.targeting.balance!.movementAbove !== undefined || p.targeting.balance!.movementBelow !== undefined),
  );

  const [purchases, balances, movement] = await Promise.all([
    needsPurchases
      ? deps.purchaseLedgerService.getPurchases(params.userId, Date.now() - purchaseLookbackDays * 24 * 60 * 60 * 1000).catch((err) => {
          deps.logger?.error({ error: err instanceof Error ? err.message : 'unknown error' }, `${logPrefix}: purchase history unavailable`);
          return [] as PurchaseEntry[];
        })
      : Promise.resolve([] as PurchaseEntry[]),
    needsCurrentBalance
      ? deps.balanceService.getBalances([params.userId]).catch((err) => {
          deps.logger?.error({ error: err instanceof Error ? err.message : 'unknown error' }, `${logPrefix}: wallet balance unavailable`);
          return new Map<string, number>();
        })
      : Promise.resolve(new Map<string, number>()),
    needsMovement
      ? deps.purchaseLedgerService.getMovement(params.userId, movementSinceMs).catch((err) => {
          deps.logger?.error({ error: err instanceof Error ? err.message : 'unknown error' }, `${logPrefix}: wallet movement unavailable`);
          return undefined;
        })
      : Promise.resolve(undefined),
  ]);

  return {
    purchases,
    walletBalanceKopecks: balances.get(params.userId),
    walletMovementKopecks: movement,
  };
}
```

Добавить недостающий импорт типа `PurchaseEntry` и `Promo` в шапку файла, если их там ещё нет (сверить с уже существующими импортами `SearchHistoryEntry`/`Promo` — вероятно уже есть, добавить только `PurchaseEntry`):

```ts
import type { PurchaseEntry } from '../../promo-selector/checkers/Checker';
```

- [ ] **Step 2: Вызвать загрузчик в `handleSelectPromo`**

В `handleSelectPromo` (тот же файл), сразу после строки
`const searchHistory = await loadSearchHistoryForSelection(params, promos, skip, deps, 'select-promo');`:

```ts
  const wallet = await loadWalletDataForSelection(params, promos, skip, deps, 'select-promo');
```

И в вызове `selectPromo(promos, { ... }, { ... })` — в объект контекста (тот, что содержит `searchHistory,`) добавить сразу за ним:

```ts
        purchases: wallet.purchases,
        walletBalanceKopecks: wallet.walletBalanceKopecks,
        walletMovementKopecks: wallet.walletMovementKopecks,
```

- [ ] **Step 3: То же самое в `handle-list.ts`**

В `src/models/select-promo/handle-list.ts` — импорт:

```ts
import { loadWalletDataForSelection, type SelectPromoDeps } from './handle';
```

(добавить `loadWalletDataForSelection` к уже существующему импорту из `./handle`, где уже есть `loadSearchHistoryForSelection, stripToAdvertisement, recordTraceObservability`).

После строки `const searchHistory = await loadSearchHistoryForSelection(params, promos, skip, deps, 'select-promo-list');`:

```ts
  const wallet = await loadWalletDataForSelection(params, promos, skip, deps, 'select-promo-list');
```

В вызове `selectPromoList(promos, { ... }, { ... })`, в объект контекста рядом с `searchHistory,`:

```ts
        purchases: wallet.purchases,
        walletBalanceKopecks: wallet.walletBalanceKopecks,
        walletMovementKopecks: wallet.walletMovementKopecks,
```

- [ ] **Step 4: Подключить сервисы в `server.ts`**

В `src/server.ts` — импорты (добавить рядом с `createSearchHistoryService`):

```ts
import { createPurchaseLedgerService } from './services/purchase-ledger-service';
import { createBalanceService } from './services/balance-service';
```

`createBalanceService` там уже импортирован (используется для `auctionDeps`) — проверить перед добавлением дубликата импорта; если уже есть, не дублировать строку импорта.

В конструктор `const deps: SelectPromoDeps = { ... }`, сразу после `searchHistoryService: createSearchHistoryService(),`:

```ts
    purchaseLedgerService: createPurchaseLedgerService(),
    balanceService: createBalanceService(),
```

- [ ] **Step 5: Запустить полный набор тестов**

Run: `npm test`
Expected: PASS. Если существующие тесты `handle.test.ts`/`handle-list.test.ts` мокают `deps: SelectPromoDeps` напрямую (частичным объектом) — TypeScript может потребовать добавить `purchaseLedgerService`/`balanceService` в мок-объекты этих тестов. Если тесты используют `Partial<SelectPromoDeps>` или мокают через `vi.fn()`-заглушки — добавить туда:

```ts
purchaseLedgerService: { getPurchases: vi.fn(async () => []), getMovement: vi.fn(async () => 0) },
balanceService: { getBalances: vi.fn(async () => new Map()) },
```

(искать по `grep -rn "SelectPromoDeps" src/models/select-promo/*.test.ts` — если такие моки есть, обновить каждый; если тесты строят deps через общий тестовый хелпер — обновить хелпер в одном месте).

- [ ] **Step 6: Typecheck и commit**

```bash
npm run typecheck
git add src/models/select-promo/handle.ts src/models/select-promo/handle-list.ts src/server.ts
git commit -m "feat(select-promo): wire purchase/balance data loading into selection walk"
```

Если Step 5 потребовал правок тестовых файлов — добавить их в тот же коммит.

---

### Task 8: promo-cabinet — схема

**Files:**
- Modify: `src/lib/schema.ts` (репозиторий `promo-cabinet`)

**Interfaces:**
- Produces: `purchasesTargetingSchema`, `balanceTargetingSchema` — используются в Task 9, 10.

**Префлайт (перед первой правкой в этом репозитории):**

```bash
cd promo-cabinet
git fetch origin main
git switch -c feat/purchase-balance-checkers origin/main
```

- [ ] **Step 1: Добавить схемы**

В `src/lib/schema.ts`, сразу после `export const searchTargetingSchema = z.object({...});`:

```ts
export const packTypeSchema = z.enum(['bump', 'premium', 'vip']);

export const purchasesTargetingSchema = z.object({
  purchased: z.boolean().optional(),
  minTotalKopecks: z.number().int().nonnegative('Сумма не может быть отрицательной').optional(),
  maxTotalKopecks: z.number().int().nonnegative('Сумма не может быть отрицательной').optional(),
  minCount: z.number().int().nonnegative('Количество не может быть отрицательным').optional(),
  maxCount: z.number().int().nonnegative('Количество не может быть отрицательным').optional(),
  packTypes: z.array(packTypeSchema).optional(),
  lookbackDays: z
    .number()
    .int('Период должен быть целым числом дней')
    .min(1, 'Период — не меньше 1 дня')
    .max(365, 'Период — не больше 365 дней')
    .optional(),
});

export const balanceTargetingSchema = z.object({
  currentAbove: z.number().int().optional(),
  currentBelow: z.number().int().optional(),
  movementAbove: z.number().int().optional(),
  movementBelow: z.number().int().optional(),
  movementLookbackDays: z
    .number()
    .int('Период должен быть целым числом дней')
    .min(1, 'Период — не меньше 1 дня')
    .max(365, 'Период — не больше 365 дней')
    .optional(),
});
```

- [ ] **Step 2: Подключить в `servingBlockSchema.targeting`**

В том же файле, в `servingBlockSchema`, в объекте `targeting: z.object({...})`, сразу после `search: searchTargetingSchema.optional(),`:

```ts
    purchases: purchasesTargetingSchema.optional(),
    balance: balanceTargetingSchema.optional(),
```

- [ ] **Step 3: Typecheck**

Run: `cd promo-cabinet && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Существующий тест схемы — проверить, не ловит ли он полный список ключей targeting**

Run: `grep -n "targeting" src/lib/schema.test.ts`

Если находится тест, явно перечисляющий ожидаемые ключи `targeting` (например через `Object.keys` или snapshot) — обновить его, добавив `purchases`/`balance`. Если такого теста нет — пропустить этот шаг, Step 5 достаточно.

- [ ] **Step 5: Написать тест на новые схемы**

Добавить в `src/lib/schema.test.ts` (или создать блок, если файла с тестами конкретно под `search`/`purchases`/`balance` схемы ещё нет — искать существующий `describe('searchTargetingSchema'` как образец):

```ts
describe('purchasesTargetingSchema', () => {
  it('accepts an empty object', () => {
    expect(purchasesTargetingSchema.safeParse({}).success).toBe(true);
  });
  it('accepts a fully specified rule', () => {
    const result = purchasesTargetingSchema.safeParse({
      purchased: true,
      minTotalKopecks: 100000,
      packTypes: ['vip', 'bump'],
      lookbackDays: 60,
    });
    expect(result.success).toBe(true);
  });
  it('rejects an unknown pack type', () => {
    expect(purchasesTargetingSchema.safeParse({ packTypes: ['gold'] }).success).toBe(false);
  });
  it('rejects lookbackDays outside 1..365', () => {
    expect(purchasesTargetingSchema.safeParse({ lookbackDays: 0 }).success).toBe(false);
    expect(purchasesTargetingSchema.safeParse({ lookbackDays: 366 }).success).toBe(false);
  });
});

describe('balanceTargetingSchema', () => {
  it('accepts an empty object', () => {
    expect(balanceTargetingSchema.safeParse({}).success).toBe(true);
  });
  it('accepts negative movement thresholds (net spend)', () => {
    expect(balanceTargetingSchema.safeParse({ movementBelow: -50000 }).success).toBe(true);
  });
});
```

Добавить импорт `purchasesTargetingSchema, balanceTargetingSchema` в начало тестового файла, рядом с существующим импортом `searchTargetingSchema` (если он там уже импортируется — сверить).

- [ ] **Step 6: Запустить тесты**

Run: `npx vitest run src/lib/schema.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/schema.ts src/lib/schema.test.ts
git commit -m "feat(schema): add purchasesTargetingSchema and balanceTargetingSchema"
```

---

### Task 9: promo-cabinet — очистка пустых блоков в `to-persisted.ts`

**Files:**
- Modify: `src/components/promo-form/to-persisted.ts`
- Test: `src/components/promo-form/to-persisted.test.ts`

**Interfaces:**
- Consumes: `purchasesTargetingSchema`, `balanceTargetingSchema` не напрямую (используется форма `Promo['targeting']`, Task 8 уже расширила её через `servingBlockSchema`).

- [ ] **Step 1: Написать падающий тест**

Открыть `src/components/promo-form/to-persisted.test.ts`, найти существующий тест на очистку `targeting.search` (искать `hasSearchCriteria` или `search` в описаниях тестов) как образец, добавить рядом:

```ts
it('strips an empty purchases block (no fields set → no criterion)', () => {
  const values = makeValidPromo({ targeting: { purchases: {} } });
  const result = toPersisted(values);
  expect(result.targeting.purchases).toBeUndefined();
});

it('keeps a purchases block with only purchased:false set', () => {
  const values = makeValidPromo({ targeting: { purchases: { purchased: false } } });
  const result = toPersisted(values);
  expect(result.targeting.purchases).toEqual({ purchased: false });
});

it('strips an empty balance block (no fields set → no criterion)', () => {
  const values = makeValidPromo({ targeting: { balance: {} } });
  const result = toPersisted(values);
  expect(result.targeting.balance).toBeUndefined();
});

it('keeps a balance block with only currentBelow set', () => {
  const values = makeValidPromo({ targeting: { balance: { currentBelow: 0 } } });
  const result = toPersisted(values);
  expect(result.targeting.balance).toEqual({ currentBelow: 0 });
});
```

Если в файле нет готового хелпера `makeValidPromo` — найти, как существующие тесты в этом файле строят валидный `values: Promo` (обычно есть локальная функция-билдер в начале файла или в соседнем `test-utils`), и использовать тот же паттерн вместо `makeValidPromo`.

- [ ] **Step 2: Убедиться, что падает**

Run: `npx vitest run src/components/promo-form/to-persisted.test.ts`
Expected: FAIL — `purchases`/`balance` не вырезаются (текущий `normalize()` их не трогает, значит `{}` пройдёт как есть, а `purchased:false`/`currentBelow:0` тоже пройдут — проверить, какие конкретно assertions падают; ключевая: пустой `{}` должен стать `undefined`, а сейчас останется `{}`).

- [ ] **Step 3: Реализация**

В `src/components/promo-form/to-persisted.ts`, в функции `normalize()`, сразу после блока про `search`/`hasSearchCriteria` (до `return { ...values, ... }`):

```ts
  // Purchases/balance: как и search, пустой объект — не критерий. hasOwnProperty
  // здесь не нужен: любое непустое поле делает объект "настоящим" правилом.
  const purchases = values.targeting.purchases;
  const hasPurchaseCriteria = purchases !== undefined && Object.keys(purchases).length > 0;
  if (purchases && !hasPurchaseCriteria) {
    const { purchases: discardedPurchases, ...withoutPurchases } = targeting;
    void discardedPurchases;
    targeting = withoutPurchases;
  }

  const balance = values.targeting.balance;
  const hasBalanceCriteria = balance !== undefined && Object.keys(balance).length > 0;
  if (balance && !hasBalanceCriteria) {
    const { balance: discardedBalance, ...withoutBalance } = targeting;
    void discardedBalance;
    targeting = withoutBalance;
  }
```

⚠️ Обратить внимание: существующий код уже переприсваивает `targeting` в блоке про `search` (`let targeting = values.targeting; if (search && ...) { targeting = withoutSearch; }`). Новый код должен идти ПОСЛЕ этого блока и работать с уже (возможно) обновлённой переменной `targeting`, а не заново с `values.targeting` — иначе очистка `search` потеряется. Использовать `targeting.purchases`/`targeting.balance` в деструктуризации (как показано выше — `const { purchases: discardedPurchases, ...withoutPurchases } = targeting;`), не `values.targeting`.

- [ ] **Step 4: Убедиться, что проходит**

Run: `npx vitest run src/components/promo-form/to-persisted.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck и commit**

```bash
npm run typecheck
git add src/components/promo-form/to-persisted.ts src/components/promo-form/to-persisted.test.ts
git commit -m "feat(form): strip empty purchases/balance targeting blocks on save"
```

---

### Task 10: promo-cabinet — UI в `TargetingSection.tsx`

**Files:**
- Modify: `src/components/promo-form/sections/TargetingSection.tsx`

**Interfaces:**
- Consumes: `Promo['targeting']['purchases']`/`['balance']` (Task 8, через типы, выведенные из схемы).

Это UI-таск без отдельного unit-теста (компонент без своего test-файла в текущем репозитории — сверено: `TargetingSection.tsx` не имеет `.test.tsx` рядом). Проверка — вручную через дев-сервер (см. Step 3).

- [ ] **Step 1: Добавить блок «Покупки пакетов»**

В `src/components/promo-form/sections/TargetingSection.tsx`, внутри компонента `TargetingSection`, добавить чтение состояния рядом с `const search = targeting.search;`:

```ts
  const purchases = targeting.purchases;
  const balance = targeting.balance;
```

Добавить JSX-блок сразу ПОСЛЕ существующего блока «Поиск» (после `<span className="ef-hint">Учитываются запросы пользователя...</span>` и перед следующим `<div className="ef-row">` про «Разделы»/«Категории»):

```tsx
      <div className="ef-divider" />
      <div className="ef-label">Покупки пакетов</div>
      <div className="ef-row">
        <div className="ef-field">
          <label>Наличие покупок</label>
          <select
            className="ef-input"
            value={purchases?.purchased === undefined ? '' : String(purchases.purchased)}
            onChange={(e) => {
              const v = e.target.value;
              setFieldValue('targeting.purchases', {
                ...purchases,
                purchased: v === '' ? undefined : v === 'true',
              });
            }}
          >
            <option value="">Не важно</option>
            <option value="true">Были покупки</option>
            <option value="false">Не было покупок</option>
          </select>
        </div>
        <div className="ef-field">
          <label>Виды пакетов</label>
          <div className="ef-checkbox-row">
            {(['bump', 'premium', 'vip'] as const).map((pack) => (
              <label key={pack} className="ef-checkbox">
                <input
                  type="checkbox"
                  checked={purchases?.packTypes?.includes(pack) ?? false}
                  onChange={(e) => {
                    const cur = purchases?.packTypes ?? [];
                    const next = e.target.checked ? [...cur, pack] : cur.filter((x) => x !== pack);
                    setFieldValue('targeting.purchases', { ...purchases, packTypes: next.length ? next : undefined });
                  }}
                />
                {pack}
              </label>
            ))}
          </div>
        </div>
        <div className="ef-field">
          <label>Мин. сумма, ₽</label>
          <input
            type="number" min={0} className="ef-input mono"
            value={purchases?.minTotalKopecks !== undefined ? purchases.minTotalKopecks / 100 : ''}
            onChange={(e) => setFieldValue('targeting.purchases', {
              ...purchases,
              minTotalKopecks: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100),
            })}
            placeholder="—"
          />
          <FieldError name="targeting.purchases.minTotalKopecks" />
        </div>
        <div className="ef-field">
          <label>Мин. количество</label>
          <input
            type="number" min={0} className="ef-input mono"
            value={purchases?.minCount ?? ''}
            onChange={(e) => setFieldValue('targeting.purchases', {
              ...purchases,
              minCount: e.target.value === '' ? undefined : Number(e.target.value),
            })}
            placeholder="—"
          />
          <FieldError name="targeting.purchases.minCount" />
        </div>
        <div className="ef-field">
          <label>Период, дней</label>
          <input
            type="number" min={1} max={365} className="ef-input mono"
            value={purchases?.lookbackDays ?? 30}
            onChange={(e) => setFieldValue('targeting.purchases', {
              ...purchases,
              lookbackDays: Number(e.target.value),
            })}
          />
          <FieldError name="targeting.purchases.lookbackDays" />
        </div>
      </div>
      <span className="ef-hint">
        Смотрит покупки VIP/premium/bump-пакетов за выбранный период. Если ничего не выбрано, фильтр выключен.
      </span>

      <div className="ef-divider" />
      <div className="ef-label">Кошелёк</div>
      <div className="ef-row">
        <div className="ef-field">
          <label>Остаток от, ₽</label>
          <input
            type="number" className="ef-input mono"
            value={balance?.currentAbove !== undefined ? balance.currentAbove / 100 : ''}
            onChange={(e) => setFieldValue('targeting.balance', {
              ...balance,
              currentAbove: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100),
            })}
            placeholder="—"
          />
        </div>
        <div className="ef-field">
          <label>Остаток до, ₽</label>
          <input
            type="number" className="ef-input mono"
            value={balance?.currentBelow !== undefined ? balance.currentBelow / 100 : ''}
            onChange={(e) => setFieldValue('targeting.balance', {
              ...balance,
              currentBelow: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100),
            })}
            placeholder="—"
          />
        </div>
        <div className="ef-field">
          <label>Движение от, ₽</label>
          <input
            type="number" className="ef-input mono"
            value={balance?.movementAbove !== undefined ? balance.movementAbove / 100 : ''}
            onChange={(e) => setFieldValue('targeting.balance', {
              ...balance,
              movementAbove: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100),
            })}
            placeholder="—"
          />
          <span className="ef-hint">Пополнения минус траты за период</span>
        </div>
        <div className="ef-field">
          <label>Движение до, ₽</label>
          <input
            type="number" className="ef-input mono"
            value={balance?.movementBelow !== undefined ? balance.movementBelow / 100 : ''}
            onChange={(e) => setFieldValue('targeting.balance', {
              ...balance,
              movementBelow: e.target.value === '' ? undefined : Math.round(Number(e.target.value) * 100),
            })}
            placeholder="—"
          />
        </div>
        <div className="ef-field">
          <label>Окно движения, дней</label>
          <input
            type="number" min={1} max={365} className="ef-input mono"
            value={balance?.movementLookbackDays ?? ''}
            onChange={(e) => setFieldValue('targeting.balance', {
              ...balance,
              movementLookbackDays: e.target.value === '' ? undefined : Number(e.target.value),
            })}
            placeholder="за всё время"
          />
          <FieldError name="targeting.balance.movementLookbackDays" />
        </div>
      </div>
      <span className="ef-hint">
        Остаток — текущий баланс кошелька. Движение — без указания окна считается с момента создания кошелька.
      </span>
```

- [ ] **Step 2: Typecheck**

Run: `cd promo-cabinet && npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Ручная проверка через дев-сервер**

Run: `npm run dev` (или актуальная команда дев-сервера этого репозитория — сверить `package.json` scripts, вероятно `next dev`)

Открыть форму создания/редактирования промо, раскрыть таргетинг, убедиться:
- блоки «Покупки пакетов» и «Кошелёк» отображаются после «Поиск»;
- ввод суммы в рублях, сохранение и повторное открытие формы показывает то же значение (проверяет конвертацию ₽↔копейки в оба конца);
- если ничего не заполнено в новом блоке — после сохранения и перезагрузки формы блок пуст (проверяет `to-persisted.ts` из Task 9).

- [ ] **Step 4: Полный прогон тестов + commit**

```bash
npm test
npm run typecheck
git add src/components/promo-form/sections/TargetingSection.tsx
git commit -m "feat(form): add Покупки пакетов and Кошелёк targeting blocks to TargetingSection"
```

---

## Self-Review (выполнено при написании плана)

**Покрытие спеки:** оба чекера (Task 4, 5), общее ограничение по авторизации
(во всех чекерах явно в `check()`), сервис-читатель (Task 3), `CheckContext`
(Task 2), `types.ts` (Task 1), регистрация (Task 6), загрузка в
handle/handle-list (Task 7), UI (Task 10), схема+strip пустых блоков (Task 8,
9). Наблюдаемость — не отдельная задача, она бесплатна (chekер уже пишется в
трейс по имени, ничего не нужно менять) — упомянуто в спеке как «вне охвата
доп. работы», в план отдельным таском не выносилось намеренно.

**Проверка плейсхолдеров:** пройдено — каждый шаг несёт реальный код, не
описание. Единственные места, помеченные «сверить с существующим кодом»
(Step 5 Task 7, Step 4 Task 8, Step 1 Task 9) — это не TODO, а инструкция
проверить актуальное состояние файла перед правкой, т.к. эти файлы меняются
активно другими задачами; сама правка расписана полностью в каждом случае.

**Согласованность типов:** `PurchaseEntry.pack` — везде `'bump'|'premium'|'vip'`
(Checker.ts, types.ts, purchase-ledger-service.ts, Purchases.ts, schema.ts,
TargetingSection.tsx). `CheckContext.purchases`/`walletBalanceKopecks`/
`walletMovementKopecks` — имена идентичны в Task 2 (объявление), Task 4/5
(чтение), Task 7 (запись). `SelectPromoDeps.purchaseLedgerService`/
`.balanceService` — имена идентичны в Task 3 (тип), Task 7 (объявление в
интерфейсе и запись в server.ts).

---

## Порядок раскатки (после реализации, отдельно от этого плана)

Обе ветки (`promo-bff` и `promo-cabinet`) — через PR, без прямого пуша в main,
по тому же правилу, что применялось для `SearchChecker`. Порядок:
promo-bff (чекеры) → дождаться мержа и деплоя → promo-cabinet (форма) —
чтобы старый BFF не получил незнакомые поля раньше, чем научится их понимать
(тот же риск, что был явно расписан в PR #12).
