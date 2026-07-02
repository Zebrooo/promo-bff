# Per-catalog promo queues — design

**Goal:** Rename/restructure promo queues so each queue is named after the **catalog it renders in**, with **no ad-format word in the name** (per product decision 2026-07-01). Today's queues are format-named and site-wide (`home-banner`=topline everywhere, `home-popup`=overlay everywhere, `tooltip`, `cabinet-onboarding`). The misleading `home-` prefix and the type-in-name are what this fixes.

## The 3-repo reality (discovered)

Queues are three S3 object types under the promo bucket: `promos.json` (the pool), `queues.json` (the queue index), `queue-<name>.json` (ordered promo-ids + `persist` flag). Ownership:

- **`~/promo-cabinet`** (Next.js admin UI) is "the cabinet" that authors promos + queues and **publishes** them to S3 (`src/app/api/queues/*`, `api/promos/*`; free-form queue creation, dynamic `queuesIndex`, `ensureMainQueue`). Promos already carry a `format` field. → the queue **data migration** happens here, by the operator, **no code change required**.
- **`~/promo-bff`** (Fastify) only **reads** S3 and runs the checker pipeline. `select-promo` returns the first promo in the queue passing all checkers. It is **name-agnostic** — it fetches whatever `queue` string arrives. → gains the new **format gate**.
- **`~/abkhaz-auto-web`** (storefront) defines the queue names in `src/lib/promo-slots.ts` and calls `getSelectedPromo({queue, ...})` from 4 surfaces. → call sites change to pass **catalog queue + acceptable formats**.

**Hard risk (real incident 2026-05-31):** a mismatch between `queues.json` (what S3 has) and the queue names the storefront requests makes banners go **dark** with no error. `scripts/bff-smoke.mjs` is the guard. Any cutover must keep S3 and storefront in lockstep and pass smoke.

## Naming map (catalog → queue)

Use the app's existing catalog vocabulary (`AD_PAGES` keys), type-free:

| Renders in | Queue name |
|---|---|
| Главная | `home` |
| Транспорт (avto/запчасти/шины/диски) | `transport` |
| Недвижимость | `realty` |
| Товары / барахолка | `goods` |
| Услуги | `services` |
| Работа | `jobs` |
| Новости | `news` |
| Страница объявления | `listing` |
| Кабинет (онбординг тур) | `cabinet` |

`main` stays as the BFF default (dead in prod, safety fallback). Old queues (`home-banner`, `home-popup`, `tooltip`, `cabinet-onboarding`) are **retired only after** the new ones serve.

## Selection-model change (the crux)

Today the **queue** is the surface selector (one queue per format-family). Per-catalog queues hold **mixed formats**, so the surface (topline / overlay / tooltip / onboarding) must be requested another way. Chosen mechanism — **optional `formats[]` on `select-promo`, backward-compatible**:

- Storefront sends `formats: string[]` = the formats acceptable for this surface.
- BFF adds a `FormatChecker`: `shouldSkip` when `ctx.formats` is absent (→ current behavior preserved), else gate `promo.format ∈ ctx.formats`.
- Because it's **skip-when-absent**, the BFF change ships and deploys with **zero effect** on today's callers, then the storefront opts in per surface. Safe, independent cutover.

Surface → acceptable formats (from the current client-side filters):

| Surface | Formats | skipCheckers (per-request) |
|---|---|---|
| topline | `['topline']` | `['limit','cooldown']` (always-show) |
| overlay | `['popup','fullscreen','inline','divkit']` | `[]` |
| tooltip | `['tooltip']` | `[]` |
| onboarding | `['tooltip']` | `[]` |

`persist` (always-show) stops being a queue property and rides on per-request `skipCheckers` (already supported; topline already passes them). New catalog queues are all **non-persist**.

## Cross-repo change list

### A. promo-bff (code) — ships FIRST, backward-compatible
1. `src/services/catalogue-schema.ts` / `promo-selector/types.ts` — no pool change; promos already have `format`.
2. `src/models/select-promo/validate.ts` — accept optional `formats?: string[]` (array of strings; ignore empties).
3. `src/models/select-promo/handle.ts` — thread `formats` into the selection `ctx`.
4. `src/promo-selector/checkers/registry/Format.ts` (NEW) — `shouldSkip` when no `ctx.formats`; else `check` = `formats.includes(promo.format)`. Register in `checkers/index.ts` (order: after `device`, before `seller`). Add `ctx.formats` to `types.ts`.
5. Tests: `Format.test.ts` (skip when absent; include/exclude by format), and a `select-promo` handle test proving `formats` narrows the pick.
6. Deploy (rsync → `31.220.42.62`, port 3191; `systemctl restart promo-bff`; run `scripts/bff-smoke.mjs`). No behavior change yet (no caller sends `formats`).

### B. promo-cabinet (operator data migration, no code) — SECOND
1. In the cabinet UI, create the catalog queues (`home, transport, realty, goods, services, jobs, news, listing, cabinet`).
2. Move/author the existing promos into the correct catalog queue(s) (a topline promo meant for the transport catalog → `transport` queue, etc.). A promo can live in several catalog queues.
3. Publish → S3 updates `queues.json` + `queue-<catalog>.json`. Verify via smoke that each catalog queue resolves.
   - **This is an operator/user step** — I can't publish to the bucket; I can prepare the exact queue contents and instructions.

### C. abkhaz-auto-web (code) — THIRD, flips serving
1. `src/lib/promo-slots.ts` — restructure to keyed-by-**surface** with `{ formats, skipCheckers }`, and derive the **catalog queue** from the current page/route:
   ```ts
   export const SURFACES = {
     topline:    { formats: ['topline'],                          skipCheckers: ['limit','cooldown'] },
     overlay:    { formats: ['popup','fullscreen','inline','divkit'], skipCheckers: [] },
     tooltip:    { formats: ['tooltip'],                          skipCheckers: [] },
     onboarding: { formats: ['tooltip'],                          skipCheckers: [], queue: 'cabinet' },
   } as const;
   // catalog derived from route: '/transport'→'transport', '/nedvizhimost'→'realty', … , default 'home'
   ```
2. `src/lib/promo.ts` `GetPromoOptions` — add `formats?: string[]`; POST it in the `select-promo` params.
3. `src/lib/promo-section.ts` — extend to also return the **catalog queue** for a pathname (reuse the existing prefix map; add goods/services/jobs/news/listing/home).
4. Call sites pass `{queue: catalogFor(path), formats: SURFACES.x.formats, skipCheckers: SURFACES.x.skipCheckers}`:
   - `ToplineSlot` / (post-CC) `ToplineSlotClient` — **now needs catalog context** (it's site-wide today). Derives catalog from `usePathname()`. NOTE: intersects the Cache-Components migration, which already moves ToplineSlot to a client island with `usePathname` — do these together or sequence CC first.
   - `src/app/api/fp/o/route.ts` (overlay) — already derives section from URL; map section→catalog.
   - `src/app/api/fp/tooltip/route.ts` — derive catalog from referer/route.
   - `src/app/api/fp/onboarding/route.ts` — fixed `queue: 'cabinet'`.
5. Deploy storefront (blue-green). Smoke: each surface on each catalog returns the right-format promo; blank check.

### D. Retire old queues — FOURTH
Once new queues serve, delete `home-banner`/`home-popup`/`tooltip`/`cabinet-onboarding` from `queues.json` via the cabinet. Keep for a grace window for rollback.

## Cutover sequence & safety
`A (bw-compat, no-op)` → `B (author new queues in S3)` → `C (storefront flips to catalog+formats)` → smoke → `D (retire old)`. Each step is independently reversible; A/B change nothing user-visible; C is the only serving flip and is guarded by `bff-smoke.mjs` + blue-green rollback.

## Open decisions for sign-off
1. **Queue name style**: `transport/realty/goods/...` (proposed) vs `catalog-transport/...` (matches `AD_PAGES` keys exactly) vs `avto/nedvizhimost/...` (route roots). Pick one.
2. **Do topline/overlay/tooltip actually need to differ per catalog?** If the operator wants the *same* topline everywhere, they author it into every catalog queue (or we keep a shared `home` queue as the default). Per-catalog is the capability; the operator decides how much to differentiate.
3. **Sequencing vs the Cache-Components migration** — ToplineSlot is touched by both. Recommend: land the BFF format gate (A) now (harmless), do the storefront flip (C) *after or together with* the CC ToplineSlotClient move.

---

## SUPPLEMENT 2026-07-02 — итоги независимого аудита (48-агентный прогон, все пункты верифицированы адверсариально)

Аудит план-vs-код по трём репозиториям подтвердил ядро плана (шаг A реализован корректно, b4b5119 смёржен в main; 4 call-site'а подтверждены; счётчики limit/cooldown ключуются на `promo.id` — переименование очередей их не трогает), но нашёл 4 подтверждённых пробела, которые меняют состав шагов.

### S-1. `bff-smoke.mjs` НЕ является «the guard» (CRITICAL, подтверждено)
`scripts/bff-smoke.mjs:26-31` захардкожен на 2 старые очереди (`home-banner`, `home-popup`) — tooltip/cabinet-onboarding уже сегодня не проверяются; пустая очередь = WARN, не fail (`:84-87`); поле `format` не читается вовсе → класс отказа «очередь непуста, но нет промо нужного формата → поверхность тёмная» невидим; после шага D скрипт начнёт падать на здоровой системе (`:74-76`).
**Новый шаг A'** (до B): переписать smoke на data-driven матрицу «прод-очередь × требуемые форматы» (пул читает `format` из promos.json), пустота очереди — фатальна под флагом `--strict-empty` (включать на время cutover), старые имена уходят из матрицы синхронно с шагом D. Дополнительно: в BFF различать `no_promo` vs `queue_not_found` (`config-service.ts:37-40` сейчас молча отдаёт пустоту) хотя бы в логах.

### S-2. Шаг D требует правки кода promo-cabinet (MAJOR, подтверждено)
«No code change required» верно только для шага B (POST /api/queues принимает свободный slug). Но `CANONICAL_QUEUES` (`promo-cabinet/src/lib/catalogue.ts:74-79`) содержит все 4 старых имени, а `ensureMainQueue()` (`:125-134`) вызывается на каждом рендере `/cabinet/queues` и GET `/api/queues` и **воскрешает удалённые канонические очереди** (home-banner — снова с persist:true). Шаг D = код-изменение: убрать 4 старых имени из `CANONICAL_QUEUES` + деплой кабинета. Заодно (шаг B'): добавить 8 новых catalog-имён в `CANONICAL_QUEUES` — bootstrap сам создаст пустые очереди, оператору не надо кликать «Создать» 8 раз, и случайное удаление не оставит прод без очереди.

### S-3. Конфликт с in-flight планом cabinet-onboarding (MAJOR, подтверждено) — РЕШЕНИЕ
План онбординга (`2026-07-01-ad-cabinet-onboarding.md`) захардкодил очередь `cabinet-onboarding` как контракт, и его Part B уже задеплоена в код: `promo-cabinet catalogue.ts:78` (коммит 6800b86), `web promo-slots.ts:32`, `/api/fp/onboarding`. **Решение: очередь `cabinet-onboarding` НЕ переименовываем** — она и так per-catalog по смыслу (каталог «кабинет»), а `cabinet` убираем из naming map. Итоговый набор новых очередей: `home, transport, realty, goods, services, jobs, news, listing` (8 шт.) + существующая `cabinet-onboarding`. Naming map строки 29 и шаг D скорректированы этим решением: retire-список = `home-banner, home-popup, tooltip` (3 имени, БЕЗ cabinet-onboarding).

### S-4. Нет процедуры бэкапа S3 при last-write-wins записи (MAJOR, подтверждено)
Запись в бакет — безусловный PUT (`catalogue.ts:17-18`), версионирования нет; «each step is independently reversible» для B/D данными не обеспечено. **Новый шаг**: `promo-bff/scripts/s3-snapshot.mjs` — выкачивает `promos.json`, `queues.json`, все `queue-*.json` в датированную папку + печатает команду restore. Снапшот обязателен непосредственно перед B и перед D.

### S-5. Правила миграции данных для шага B (дополнение к B2)
- **Сохранять id промо** при перекладке (queue-json хранит только ссылки-ids): пере-создание промо сбросит частотные счётчики (`Frequency.ts:13,28` ключуются на promo.id) и переиграет показанные туры.
- **sections/categories**: ContextChecker остаётся в пайплайне; промо с заполненными `sections`, попавшее в «чужую» каталожную очередь, молча не покажется. Правило: при перекладке в catalog-очередь `sections/categories` либо очищаются (каталог теперь задаёт очередь), либо проверяются на совместимость. Учесть fail-closed: сегодня section передаёт ТОЛЬКО overlay-роут — промо с sections на topline/tooltip/onboarding не показываются вовсе (`Context.ts:15`), это существующий баг-класс, см. план фиксов аудита.
- Таргетинг `premium` мёртв (`billing-service.ts:41` возвращает только plus/none) — при раскладке не использовать; кабинет теперь предупреждает.

### Мелкие правки плана (факт-чекинг)
- A4: `ctx.formats` живёт в `checkers/Checker.ts` (CheckContext) + `promo-selector/index.ts` — файла `checkers/types.ts` не существует.
- «Formats from the current client-side filters» — неточно: реально формат сегодня фильтрует только topline (`ToplineSlot.tsx:23`); наборы форматов таблицы — продуктовая фиксация, для overlay/tooltip это НОВОЕ серверное ограничение. В C5-смоук добавить проверку overlay на смешанной очереди.
- Open decision 1 надо закрыть ДО начала B (имена уходят в S3-данные): рекомендация — короткие type-free имена из таблицы (`transport`, не `catalog-transport`), сведя в коде единую таблицу route-префикс → section → AD_PAGES key → queue.
- Перф (не блокер): `fetchQueue` качает весь пул на каждый cache-miss очереди; с 9+ очередями пул будет скачиваться ×9 за TTL-окно. Фикс: отдельная кэш-запись `pool` в `config-service.ts`.

### Обновлённая последовательность cutover
`A (done, merged)` → **`A' (smoke rewrite + snapshot script + BFF hardening из плана фиксов)`** → deploy BFF → **snapshot S3** → `B (оператор; очереди авто-созданы через CANONICAL_QUEUES после деплоя кабинета)` → smoke (`--strict-empty`) → `C (storefront flip, после/вместе с CC ToplineSlot)` → smoke → **snapshot S3** → `D (retire home-banner/home-popup/tooltip: правка CANONICAL_QUEUES + деплой кабинета + удаление через UI + имена из smoke-матрицы)`.
