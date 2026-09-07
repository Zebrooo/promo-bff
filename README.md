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

### User identity contract

`params.user.isAuthorized` is the canonical current-login flag and controls only
the `audience` checker. Legacy callers may still send `authenticated`; the BFF
normalizes it to `isAuthorized` and rejects conflicting values. `identityKind`
(`account` or `anonymous`) independently controls profile, billing and listing
DataSync, so a verified account identity remains usable after logout while
`isAuthorized:false` correctly leaves the authenticated audience.

An explicit `identityKind:"account"` requires a detached Ed25519 proof bound to
`user.id`, the authenticated service-ticket `src`, this BFF's `dst`, and a
maximum 60-second validity window. It reuses `PROMO_TICKET_PUBLIC_KEY`; no new
secret is needed. For BFF-first rollout compatibility, requests that omit
`identityKind` retain the legacy behavior (`authenticated:true` means account,
otherwise anonymous). Impressions are never TTL-cached: cooldown/frequency reads
the shared store on every selection, immediately after `/impressions` and across
BFF instances. A candidate's `cooldownHours` is measured from the viewer's most
recent impression of any promo id, so changing formats or queues cannot restart
the window.

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

### Production Docker Compose

On aaprod, `.env` must define non-empty `AA_SUPABASE_URL` and
`AA_SUPABASE_SERVICE_ROLE_KEY`. The Compose service maps those values to
`PROMO_SUPABASE_URL` and `PROMO_SUPABASE_SERVICE_ROLE_KEY`, so promo models,
impressions, and billing use the Abkhaz Auto production database even if legacy
`PROMO_SUPABASE_*` values remain in `.env`. Compose fails before starting the
container when either `AA_SUPABASE_*` source value is missing or empty.

OpenRouter calls can use a dedicated HTTP proxy by setting `OPENROUTER_PROXY` in
`.env`. Compose forwards the value unchanged; an empty value keeps direct fetch.
The proxy applies only to the text and image OpenRouter clients, never to
Supabase, S3, or other BFF traffic. Production must provide a proxy URL reachable
from the `promo-bff` container.

### Durable push campaigns

The cabinet uses ticket-authenticated, POST-only `/push-admin/campaigns/*`
endpoints to create, preview, schedule, inspect, and cancel campaigns. API
handlers only write/read durable Supabase state and return immediately; they
never call Firebase. Every mutation is fenced by a campaign revision and a
UUID command id, and queueing additionally confirms the frozen audience digest,
payload hash, exact recipient count, and configured maximum audience.
Campaign listing always includes every nonterminal campaign, independently of
the requested `limit`; that limit applies only to recent terminal history. The
BFF reads nonterminal rows in explicit pages and fails closed above 5,000 active
campaigns instead of silently hiding an older scheduled campaign.

Delivery runs in the separate `promo-push-worker` Compose service. It has no
public port and is the only container that receives the Firebase credential.
Before starting it in production:

1. Apply the matching Abkhaz Auto Supabase push-campaign migration.
2. Add `promo-cabinet` to `PROMO_ALLOWED_SRC` and set
   `PUSH_ADMIN_ALLOWED_SRC=promo-cabinet`. A valid ticket from any other
   globally allowed service is rejected by the push administration routes.
3. Set `FCM_PROJECT_ID` in `.env` to the expected Firebase project id.
4. Export `FCM_SERVICE_ACCOUNT_FILE` for Docker Compose as the host path to the
   service-account JSON. Compose mounts it read-only at
   `/run/secrets/fcm_service_account`; do not put the JSON itself in `.env`.
5. Build and start both services with the worker kill switch still off:
   `docker compose up -d --build`.
6. Verify the migration, mounted credential and pinned project, then set
   `PUSH_WORKER_ENABLED=true` and recreate `promo-push-worker`.

If the Firebase project id or credential file is absent/invalid, Compose still
starts the BFF. The worker stays fail-closed, leases no campaigns, and reports
itself disabled until credentials are provisioned and the worker is restarted.
The Compose kill switch defaults to `false`; queueing also returns
`503 worker_unavailable` unless the worker has a fresh healthy heartbeat.
The initial rollout intentionally has no TEST delivery worker: TEST can create
and prepare audience previews, but queueing remains `503 worker_unavailable`.
Enable TEST delivery only after provisioning a separate worker, Firebase
project/credential, and heartbeat for that isolated environment.

Three consecutive system-level delivery outcomes (FCM 429/5xx, ambiguous
network/timeout results, or a transient OAuth refresh failure after FCM 401)
open a fail-closed circuit. The current campaign is
failed, claimed-but-unstarted recipients are closed without sending, and the
worker remains unhealthy until an operator investigates and restarts it. No
notification attempt is retried; only the already in-flight concurrency window
can complete while the circuit is being detected.
Any ambiguous storage failure after a campaign has been claimed—including a
lost `claimRecipients` response or a failed terminal outcome write—also latches
the worker unhealthy until restart. It does not falsely fail the campaign or
claim another window; unresolved claims expire to `unknown` for operator review.

Optional worker tuning variables are `PUSH_WORKER_POLL_MS`,
`PUSH_CAMPAIGN_LEASE_SECONDS`, `PUSH_RECIPIENT_LEASE_SECONDS`,
`PUSH_WORKER_BATCH_SIZE`, `PUSH_WORKER_CONCURRENCY`, `PUSH_WORKER_MAX_RPS`, and
`PUSH_SUPABASE_TIMEOUT_MS`, and `FCM_REQUEST_TIMEOUT_MS`. The worker claims no
more than one concurrency window at a time and supports the newest token plus
one exact-UNREGISTERED fallback. At startup it derives a worst-case delivery
budget from the DB timeout, FCM timeout, rate limit, and concurrency, then
rejects campaign or recipient leases shorter than that budget. Defaults are
conservative. A missing/invalid credential or mismatched project id is
fail-closed: no campaign is claimed and the cabinet reports the worker
unhealthy/disabled.

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
