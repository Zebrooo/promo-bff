# Чекер «Объявления продавца»

Статус: одобрено владельцем 13.08.2026, реализация в этот же день.
Прецедент/образец: `SellerChecker` (`src/promo-selector/checkers/registry/Seller.ts`)
и supplier `listingStats` (`src/services/listing-service.ts`) — те же данные,
тот же паттерн загрузки (не окно `lookbackDays`, как у Search/Purchase/Balance,
а снимок текущего состояния через `requiredSupplierIDs`).

## Зачем

Три цели таргетинга по собственным объявлениям продавца:

1. **Апсейл продвижения** — показывать «подними своё объявление» тем, у кого
   есть активное объявление без текущего продвижения.
2. **Категорийная релевантность** — показывать промо конкретной категории
   только тем, кто сам продаёт в этой категории.
3. **Реактивация/удержание** — таргетинг по «давно не размещал».

## Правило (`Promo.targeting.listings`)

```ts
export interface ListingsTargetingRule {
  /** Размещал ХОТЬ КОГДА-ЛИБО (любой статус) в одной из категорий. */
  categories?: string[];
  /** Общий флаг на categories И activeCategories. По умолчанию 'any'. */
  categoriesMatch?: 'any' | 'all';
  /** Есть АКТИВНОЕ объявление в одной из категорий. */
  activeCategories?: string[];
  /** Есть активное объявление без текущего продвижения (upsell-гейт). */
  hasUnpromotedActive?: boolean;
  /** Мин. число дней с последнего размещения (реактивация). */
  inactiveDays?: number;
}
```

`hasListingsRule(promo)` — true, если хоть одно поле задано (как
`hasSearchRule`/`hasPurchaseRule`/`hasBalanceRule`).

Между непустыми полями правила — обычное AND (как во всех остальных
чекерах: правило проходит, только если проходят ВСЕ заданные условия).
Внутри `categories`/`activeCategories` — any/all по `categoriesMatch`.

Анонимный посетитель (`ctx.isAuthorized === false`) не может иметь
объявлений — правило с хотя бы одним заданным полем **проваливается**
(fail-closed), как у `PurchaseChecker`/`BalanceChecker`. Пустое правило —
обычный skip.

## Источник данных — расширение `ListingStats`/`listing-service.ts`

Текущий запрос — облегчённый EXISTS-подсчёт (`select=id&limit=1` +
`Prefer: count=exact`), отдающий только `activeListings`. Заменяем его на
запрос, забирающий сами строки (обычный `select`, без `count=exact`):

```
GET /rest/v1/listings
  ?select=category_slug,status,promotion,promotion_until,created_at
  &user_id=eq.<userId>
  &order=created_at.desc
  &limit=200
```

`limit=200` — самому активному продавцу этого достаточно с большим запасом;
не оптимизируем под гипотетический хвост. Источник конфига остаётся
`config.supabase` (как сейчас в `listing-service.ts`) — не меняем на
`config.aaSupabase`, это предсуществующая мелкая непоследовательность
кодовой базы, не в скоупе этой задачи.

Из полученных строк в JS считается:

```ts
export interface ListingStats {
  activeListings: number;          // как сейчас, не трогаем
  everCategories: string[];        // уникальные category_slug по ВСЕМ статусам
  activeCategories: string[];      // уникальные category_slug где status='active'
  hasUnpromotedActive: boolean;    // есть active-строка с promotion='none' ИЛИ promotion_until < now
  daysSinceLastListing?: number;   // (now - max(created_at)) в днях; undefined = объявлений нет вообще
}
```

Один запрос обслуживает и старый `SellerChecker` (`activeListings`), и
новый `ListingsChecker` — кэш `cached('listingStats', userId, identityKind, ...)`
не меняется (60с TTL, тот же ключ).

## Чекер — `src/promo-selector/checkers/registry/Listings.ts`

```ts
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

    if (rule.categories?.length) {
      const match = rule.categoriesMatch === 'all'
        ? rule.categories.every((c) => stats.everCategories.includes(c))
        : rule.categories.some((c) => stats.everCategories.includes(c));
      if (!match) return false;
    }
    if (rule.activeCategories?.length) {
      const match = rule.categoriesMatch === 'all'
        ? rule.activeCategories.every((c) => stats.activeCategories.includes(c))
        : rule.activeCategories.some((c) => stats.activeCategories.includes(c));
      if (!match) return false;
    }
    if (rule.hasUnpromotedActive !== undefined && stats.hasUnpromotedActive !== rule.hasUnpromotedActive) return false;
    if (rule.inactiveDays !== undefined) {
      if (stats.daysSinceLastListing === undefined || stats.daysSinceLastListing < rule.inactiveDays) return false;
    }

    return true;
  }
}
```

`ListingStats` требует расширения `SuppliersData`/`SupplierTypeMap` в
`Checker.ts` — сам тип `ListingStats` уже там реэкспортирован из
`listing-service.ts`, меняется только его форма (см. выше), сигнатуры
чекеров не меняются.

## Регистрация — `src/promo-selector/checkers/index.ts`

Рядом с `SellerChecker`, в слое поведенческого/продавческого таргетинга:

```ts
export const WEB_CHECKERS: Checker<SupplierId>[] = [
  ...
  new SellerChecker(),
  new ListingsChecker(),
  ...
];
```

## promo-cabinet

Новый блок «Объявления продавца» в
`src/components/promo-form/sections/TargetingSection.tsx`, рядом с
существующими блоками. Поля `categories`/`activeCategories` — через уже
существующий `SlugListField` (используется для `categories` на самом
промо, `TargetingSection.tsx:215`), плюс переключатель any/all под ними
(radio или select, 2 значения). `hasUnpromotedActive` — чекбокс,
`inactiveDays` — числовое поле (дни, >= 0).

Схема — `listingsTargetingSchema` в `src/lib/schema.ts`, зеркалит форму
`searchTargetingSchema`, вписывается в `servingBlockSchema.targeting` как
`listings: listingsTargetingSchema.optional()`. Пустой блок вычищается в
`to-persisted.ts` (`normalize()`) тем же приёмом, что и `search`.

**Замечание по последовательности.** На момент написания этой спеки поля
`purchases`/`balance` (из параллельного плана
`2026-08-13-purchase-balance-checkers.md`) ещё не добавлены в
`servingBlockSchema`/`TargetingSection.tsx` — Tasks 8-10 того плана не
выполнены. Эта задача (`feat/listings-targeting-checker`) сделана на
отдельной ветке от свежего `origin/main` и не зависит от той ветки, но обе
трогают одни и те же файлы (`schema.ts`, `TargetingSection.tsx`,
`to-persisted.ts`) в промо-cabinet. План выполнения (следующий шаг —
`writing-plans`) должен зафиксировать: promo-cabinet-часть этого плана
исполняется ПОСЛЕ того, как Purchase/Balance-фича смержена в main (простое
избежание конфликта веток, не архитектурное ограничение) — promo-bff-часть
(чекер + supplier) можно исполнять независимо и раньше.

## Наблюдаемость

Ничего сверх существующего — чекер автоматически попадает в
`promo_selection_traces`/`promo_checker_stats` по имени (`'listings'`),
тот же generic-механизм, что уже несёт `SellerChecker`/`SearchChecker`.

## Тесты

- `listing-service.test.ts` — новые кейсы на `everCategories`/
  `activeCategories`/`hasUnpromotedActive`/`daysSinceLastListing`
  (мокнутый fetch, как существующие тесты `getListingStats`).
- `Listings.test.ts` — по образцу `Seller.test.ts`/`Balance.test.ts`:
  `shouldSkip`, `check()` на каждое поле правила отдельно и в комбинации,
  `categoriesMatch: 'any'` vs `'all'`, неавторизованный посетитель с
  непустым правилом → `false`.

## Вне охвата

- Не трогаем `SellerChecker` — его булев `sellerStatus` остаётся как есть,
  задачи не пересекаются по семантике (seller/buyer — грубый бинарный
  сигнал; `listings` — детальный категорийный/upsell/реактивационный).
- Не добавляем RPC/view на стороне abkhaz-auto (вариант C из брейнсторма) —
  один расширенный REST-запрос к `listings` достаточен на этом масштабе.
- Не кэшируем `daysSinceLastListing`/`hasUnpromotedActive` отдельно от
  остального `listingStats` — один и тот же 60-секундный TTL на всю
  структуру.
- Не добавляем лейбл «вам показывают это, потому что...» — как и у всех
  остальных поведенческих чекеров, таргетинг непрозрачен для конечного
  пользователя.
