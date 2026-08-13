# Чекеры «Покупки пакетов» и «Кошелёк»

Статус: одобрено владельцем 13.08.2026, реализация в этот же день.
Прецедент/образец: `feat(promo): add search targeting checker` (promo-bff #13,
promo-cabinet #12) — тот же паттерн: чекер в promo-selector + сервис-читатель
данных из Supabase abkhaz-auto + компактный блок в `TargetingSection.tsx`.

## Зачем

Рекламодатель должен уметь настраивать показ промо по поведению посетителя
как **продавца на площадке**: тратил ли он деньги на продвижение своих
объявлений (VIP/premium/bump-пакеты) и какой у него остаток на едином
кошельке (тем же кошельком оплачиваются и пакеты, и ставки в рекламном
аукционе — `ledger_accounts`, миграция abkhaz-auto `0041_wallet_ledger.sql`).

## Ограничение, общее для обоих чекеров

Кошелёк и покупки привязаны к `ledger_accounts.owner_user_id` (uuid реального
аккаунта), а не к анонимной куке. Для неавторизованного посетителя
(`ctx.isAuthorized === false`) данных нет и не может быть — оба чекера в этом
случае **не проходят** (fail-closed), если в правиле задано хоть одно условие.
Пустое правило (ничего не настроено) — обычный skip, как у `SearchChecker.shouldSkip`.

## Источник данных — abkhaz-auto Supabase, схема `0041_wallet_ledger.sql`

```
ledger_accounts(id, key, kind, owner_user_id, balance_kopecks, created_at)
  kind='liability' и owner_user_id=<uuid> — кошелёк конкретного пользователя.
ledger_transactions(id, type, idempotency_key, ref, actor_user_id, created_at)
  type ∈ {'topup','charge','refund','adjustment'}
ledger_postings(id, transaction_id, account_id, amount_kopecks, created_at)
  append-only, знак amount_kopecks: пополнение положительное, списание
  отрицательное (двойная запись, сумма по счёту = баланс).
```

Покупка пакета — строка `ledger_transactions` с `type='charge'`,
`subject_kind='listing'`, `meta->>'pack'` ∈ `{'bump','premium','vip'}` (см.
`operations_history()`, `0093_operations_history.sql`, строки 83-91 — оттуда
взят разбор `meta->>'pack'`). RPC `operations_history` не используем — она
завязана на `auth.uid()`, а сервис в promo-bff работает от service-role.
Вместо неё — прямой REST-запрос к `ledger_postings` с embedded
`ledger_transactions` через PostgREST (тот же приём, что в
`search-history-service.ts`):

```
GET /rest/v1/ledger_postings
  ?select=amount_kopecks,created_at,ledger_transactions!inner(type,subject_kind,meta)
  &account_id=eq.<accountId>
  &created_at=gte.<cutoff>            (для окна; опускается для «за всё время»)
  &ledger_transactions.type=eq.charge
  &ledger_transactions.subject_kind=eq.listing
```

`accountId` берём тем же способом, что `balance-service.ts` берёт баланс:
`ledger_accounts?owner_user_id=eq.<userId>&kind=eq.liability&select=id,balance_kopecks`
— один запрос отдаёт и id счёта, и текущий баланс сразу.

## Новый сервис: `src/services/purchase-ledger-service.ts`

Копирует форму `search-history-service.ts`: `config.aaSupabase`, таймаут
~300мс (тот же бюджет, что у поиска — под общий BFF-дедлайн 800мс), fail-soft
→ пустой результат при ошибке/таймауте/не настроенном Supabase.

```ts
export interface PurchaseLedgerService {
  /** Текущий баланс — переиспользует уже существующий BalanceService.getBalances
   *  под капотом (один и тот же account lookup), здесь не дублируется. */
  getPurchases(userId: string, opts: { sinceMs?: number }): Promise<PurchaseEntry[]>;
  getMovement(userId: string, opts: { sinceMs?: number }): Promise<{ netKopecks: number }>;
}

export interface PurchaseEntry {
  pack: 'bump' | 'premium' | 'vip';
  amountKopecks: number;  // положительное число (модуль списания)
  createdAt: string;
}
```

Оба метода читают ОДИН и тот же набор постингов за один HTTP-вызов (не два) —
`getMovement` суммирует все постинги счёта (без фильтра по `type`/`subject_kind`,
это все движения кошелька), `getPurchases` — только charge/listing/pack ∈
{bump,premium,vip} из того же ответа. На уровне вызывающего кода
(`handle.ts`) это будет один `loadWalletDataForSelection()`, аналог
`loadSearchHistoryForSelection()`, который вызывает сервис один раз и кладёт
результат в `CheckContext` (новые поля `purchases?: PurchaseEntry[]` и
`walletMovementKopecks?: number`), не в оба чекера отдельно.

## `CheckContext` (Checker.ts) — новые поля

```ts
export interface CheckContext {
  // ...существующие поля...
  /** Текущий остаток кошелька, kopecks. undefined = нет счёта/не авторизован. */
  walletBalanceKopecks?: number;
  /** Покупки пакетов в окне запрошенного чекером lookbackDays (см. ниже). */
  purchases?: PurchaseEntry[];
  /** Сумма движения по кошельку в окне (пополнения минус траты). */
  walletMovementKopecks?: number;
}
```

⚠️ У `PurchaseChecker` и `BalanceChecker` могут быть РАЗНЫЕ `lookbackDays` в
одном и том же промо (это разные правила таргетинга одного промо). Поэтому
`purchases`/`walletMovementKopecks` в `CheckContext` кладём **за максимальное
окно среди всех промо в очереди** (как это уже делает `loadSearchHistoryForSelection`
— грузит по самому широкому `lookbackDays` среди кандидатов), а каждый чекер
сам фильтрует переданный ему массив по своему `lookbackDays` внутри `check()`.
`walletMovementKopecks` — отдельный вызов на КАЖДЫЙ уникальный `lookbackDays`,
запрошенный чекерами в очереди (обычно один, максимум пара) — не единое число.

## Чекер 1 — `src/promo-selector/checkers/registry/Purchases.ts`

```ts
export class PurchaseChecker extends Checker {
  readonly name = 'purchases';
  shouldSkip(ctx): false | string {
    return hasPurchaseRule(ctx.promo) ? false : 'no purchase targeting';
  }
  // isAuthorized-гейт — внутри check(), не в shouldSkip: не авторизован должен
  // ПРОВАЛИТЬ правило (false), а не молча пройти как «skip» (skip == eligible).
  check(ctx): boolean {
    const rule = ctx.promo.targeting.purchases;
    if (!ctx.isAuthorized) return false;
    const rows = (ctx.purchases ?? []).filter(inWindow(rule.lookbackDays ?? 30));
    const filtered = rule.packTypes?.length
      ? rows.filter(r => rule.packTypes.includes(r.pack))
      : rows;
    if (rule.purchased === false && filtered.length > 0) return false;
    if (rule.purchased === true && filtered.length === 0) return false;
    if (rule.minCount !== undefined && filtered.length < rule.minCount) return false;
    if (rule.maxCount !== undefined && filtered.length > rule.maxCount) return false;
    const total = filtered.reduce((s, r) => s + r.amountKopecks, 0);
    if (rule.minTotalKopecks !== undefined && total < rule.minTotalKopecks) return false;
    if (rule.maxTotalKopecks !== undefined && total > rule.maxTotalKopecks) return false;
    return true;
  }
}
```

Правило (в `Promo.targeting.purchases`, зеркалит форму `targeting.search`):

```ts
{
  purchased?: boolean;
  minTotalKopecks?: number;
  maxTotalKopecks?: number;
  minCount?: number;
  maxCount?: number;
  packTypes?: ('bump' | 'premium' | 'vip')[];
  lookbackDays?: number; // по умолчанию 30
}
```

`hasPurchaseRule(promo)` — true, если хоть одно поле задано (как `hasSearchRule`).

## Чекер 2 — `src/promo-selector/checkers/registry/Balance.ts`

```ts
export class BalanceChecker extends Checker {
  readonly name = 'balance';
  shouldSkip(ctx): false | string {
    return hasBalanceRule(ctx.promo) ? false : 'no balance targeting';
  }
  check(ctx): boolean {
    if (!ctx.isAuthorized) return false;
    const rule = ctx.promo.targeting.balance;
    if (rule.currentAbove !== undefined && (ctx.walletBalanceKopecks ?? 0) < rule.currentAbove) return false;
    if (rule.currentBelow !== undefined && (ctx.walletBalanceKopecks ?? 0) > rule.currentBelow) return false;
    if (rule.movementAbove !== undefined && (ctx.walletMovementKopecks ?? 0) < rule.movementAbove) return false;
    if (rule.movementBelow !== undefined && (ctx.walletMovementKopecks ?? 0) > rule.movementBelow) return false;
    return true;
  }
}
```

Правило (`Promo.targeting.balance`):

```ts
{
  currentAbove?: number;
  currentBelow?: number;
  movementAbove?: number;
  movementBelow?: number;
  movementLookbackDays?: number; // не задано = за всё время (с момента создания счёта)
}
```

`walletBalanceKopecks` грузится всегда, если хоть один промо в очереди задал
`targeting.balance` с `currentAbove`/`currentBelow` — переиспользуем
`BalanceService.getBalances([userId])` (уже существует, не пишем заново),
только добавляем его вызов в общий `loadWalletDataForSelection()`.

## Регистрация: `src/promo-selector/checkers/index.ts`

Оба добавляются в `WEB_CHECKERS` рядом с `SearchChecker` (после него, тот же
слой «поведенческий таргетинг» до `DeviceChecker`):

```ts
export const WEB_CHECKERS: Checker<SupplierId>[] = [
  new DateChecker(),
  new TargetingChecker(),
  new AudienceChecker(),
  new ContextChecker(),
  new SearchChecker(),
  new PurchaseChecker(),
  new BalanceChecker(),
  new DeviceChecker(),
  ...
];
```

## promo-cabinet: `src/components/promo-form/sections/TargetingSection.tsx`

Два новых компактных блока рядом с существующим «Поиск», та же механика:
пустой блок удаляется при сохранении (`to-persisted.ts`, зеркалит
`toPersistedSearch`), схема — `purchasesTargetingSchema` и
`balanceTargetingSchema` в `src/lib/schema.ts`, суммы вводятся в рублях и
конвертируются в копейки на сохранении (как везде в promo-cabinet, см.
`price_kopecks` в промо-пакетах).

## Наблюдаемость

Ничего сверх существующего — оба чекера automatically попадают в
`promo_selection_traces`/`promo_checker_stats` (generic-механизм по имени
чекера, тот же, что уже несёт `SearchChecker` в Grafану `dashboards/ads.json`).

## Тесты

По образцу `Search.test.ts` — unit-тесты на `check()`/`shouldSkip()` с
синтетическими `PurchaseEntry[]`/`walletBalanceKopecks`, плюс тест на
`purchase-ledger-service.ts` (мокнутый fetch, как `search-history-service.test.ts`
дублирует `promo-selection.test.ts`'овский approach к мокам).

## Вне охвата

- Не создаём отдельный RPC/эндпоинт — переиспользуем `/models`/`/promo-list`,
  как `SearchChecker`.
- Не трогаем `operations_history()` (страница `/lk/balans`) — читаем
  ledger-таблицы напрямую, параллельным путём.
- Не добавляем UI-лейбл «вам показывают это, потому что...» — как и у поиска,
  таргетинг непрозрачен для конечного пользователя.
- `walletMovementKopecks` не кэшируется между запросами — пересчитывается на
  каждый walk (объём данных на счёт мал, кэш избыточен на этом масштабе).
