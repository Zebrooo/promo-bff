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
