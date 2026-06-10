# Promo

Promo-selection service for the site. Given a user, it picks the single best promo
to show by running the catalogue through a chain of checkers.

TypeScript + Node.js, HTTP via **Fastify**. No Yandex frameworks. Built for the real
scale (~10k users/day, one promo per session → a few RPS): plain sequential code,
optimized for **resilience to dependency failures and debuggability**, not throughput.

## Endpoint

`POST /models`

```jsonc
// request
{
  "models": ["select-promo"],
  "params": { "userId": "user123", "context": { "platform": "web", "locale": "ru" } }
}
```

```jsonc
// response — HTTP is always 200 once a model runs; status lives in the envelope
{ "select-promo": { "status": "ok", "data": { "id": "summer-sale", "format": "popup", "title": "Летняя распродажа −30%", "description": "Скидки до 30% на весь каталог до конца лета.", "imageUrl": "https://cdn.example.com/promo/summer-sale.png", "action": { "href": "/sale/summer", "label": "Подробнее" }, "dismissible": true } } }
```

Per-model `status`:

| status    | meaning                              | fields           |
| --------- | ------------------------------------ | ---------------- |
| `ok`      | a promo matched                      | `data`           |
| `skipped` | nothing matched                      | `reason: no_promo` |
| `error`   | a dependency failed / internal error | `reason`         |

**HTTP status policy.** Request-level problems return the matching 4xx (malformed
JSON → 400, unauthorized → 401, bad/unknown model or missing `userId` → 400). Once a
model actually executes, the response is **always HTTP 200** and the envelope's
`status` distinguishes `ok` / `skipped` / `error`. So a downed external service reads
as `200 + {status:"error"}`, never a 5xx — the client can tell "no promo" apart from
"service is down" without parsing HTTP codes.

## Request chain (POST /models)

`parse JSON → authenticate → validate → execute → respond`

## select-promo logic

1. Load promos + checker config from **Bunker** (`config-service`).
2. Load user data — profile/history (`user-service`) + subscription (`billing-service`).
3. Run each promo through the checker chain.
4. Return the **first** promo that passes **all** checkers; if none, `skipped`.

### Checker chain (cheap → expensive)

| Checker        | Rejects when…                                       | example reason            |
| -------------- | --------------------------------------------------- | ------------------------- |
| `DateChecker`  | now is outside `[startsAt, endsAt]`                 | `not_started` / `expired` |
| `UserChecker`  | user outside targeting (age / region / subscription)| `region_not_targeted`     |
| `LimitChecker` | user already hit `maxImpressionsPerUser`            | `limit_exceeded`          |
| `ScoreChecker` | `baseScore * scoreMultiplier < minScore`            | `score_too_low`           |

- Each checker returns `{ ok: boolean, reason?: string }` — not a bare boolean.
- The chain runs via `.every()` with **lazy short-circuit**: the first `ok:false`
  rejects the promo and the remaining checkers are never called. Results are not
  materialized up front.
- Each checker is a pure `(userData, promo, config)` function — unit-tested without
  any network. See [src/promo-selector/checkers/](src/promo-selector/checkers/).

## External services

All access to Bunker / user data / Billing goes through clients in
[src/services/](src/services/). Each one:

- wraps every call in [`withTimeout`](src/util/with-timeout.ts) (default 2.5s, per-service,
  configurable in [src/config.ts](src/config.ts) via env vars);
- on failure or timeout, the model returns `status:"error"` with a clear reason —
  it never hangs or throws an unhandled rejection.

The clients are **stubs with realistic types and mock data**; replace the `fetch*`
bodies with real calls and the interface/timeout wrapping stay the same.

## Impression limits & the read-modify-write race

Two near-simultaneous requests from one user (two tabs) could both pass
`LimitChecker` (which only *reads* the count) and over-show a capped promo.
`LimitChecker` is a cheap pre-filter; the real guard belongs in the impression-history
storage as an **atomic conditional increment** at record time (e.g. Redis `INCR` +
compare, or `UPDATE … SET count = count + 1 WHERE count < max` checking affected rows).
This is documented as a `TODO` in
[`limit-checker.ts`](src/promo-selector/checkers/limit-checker.ts) and
[`user-service.ts → recordImpression`](src/services/user-service.ts); the stub is a no-op.

## Design defaults chosen (where the spec left a fork)

- **Promo data shape.** A promo self-describes its window, targeting, per-user cap and
  `baseScore`, so each checker reads only the fields it owns and Bunker fully describes a
  campaign without code changes. It also carries display fields (`format`, `title`,
  `description`, `imageUrl`, `action`, `dismissible`) so the `select-promo` model can
  return a fully renderable `Advertisement` (`data.id` = promoId) without a second lookup.
- **Score.** `final = promo.baseScore * userData.scoreMultiplier`, compared to a global
  `minScore` from Bunker — uses both the promo and the user's personalization signal.
- **Service → data mapping.** `config-service` = Bunker (promos + config); `user-service`
  = Blackbox/DataSync (age, region, scoreMultiplier, impression history); `billing-service`
  = Billing (subscription level). Three clients as specified.
- **`recordImpression` failure** is logged but does **not** downgrade a successful
  selection to `error` — the user still gets their promo.

## Project layout

```
src/
├── promo-selector/
│   ├── checkers/
│   │   ├── date-checker.ts
│   │   ├── user-checker.ts
│   │   ├── limit-checker.ts
│   │   └── score-checker.ts
│   ├── index.ts          # orchestrator: runs promos through the checker chain
│   └── types.ts
├── models/
│   ├── registry.ts       # model registry (one model today)
│   └── select-promo/
│       ├── validate.ts   # params validation
│       ├── handle.ts     # model logic
│       └── types.ts
├── services/
│   ├── config-service.ts # Bunker (promos + config)
│   ├── user-service.ts   # user profile + impression history
│   └── billing-service.ts
├── util/with-timeout.ts  # the single place service timeouts are enforced
├── auth.ts               # authenticator interface + stub
├── config.ts             # port/host + service timeouts
└── server.ts             # Fastify app, POST /models, request chain
```

Tests are colocated as `*.test.ts` next to each module.

## Run / test

```bash
npm install
npm run dev        # tsx watch on http://localhost:3000
npm start          # run once
npm test           # vitest (46 tests)
npm run typecheck  # tsc --noEmit
```

```bash
curl -X POST http://localhost:3000/models \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer dev-token' \
  -d '{"models":["select-promo"],"params":{"userId":"user123","context":{"platform":"web","locale":"ru"}}}'
```

## Adding a model

Write `validate` + `handle`, then add one entry to
[`src/models/registry.ts`](src/models/registry.ts). Nothing else in the server changes.
(Intentionally no speculative abstraction — there is one model today.)
