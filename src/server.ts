import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import { fileURLToPath } from 'node:url';
import { config } from './config';
import { createStubAuthenticator, type Authenticator } from './auth';
import { createTicketAuthenticator } from './auth-ticket';
import { createConfigService } from './services/config-service';
import { createUserService } from './services/user-service';
import { createBillingService } from './services/billing-service';
import { createImpressionStore } from './services/impression-store';
import { createFeedFrequencyService } from './services/feed-frequency-service';
import { createEventStore, type EventStore } from './services/event-store';
import { createErrorStore, type ErrorStore } from './services/error-store';
import { createAnalyticsStore, type AnalyticsStore } from './services/analytics-store';
import { createCheckerStatsService, type CheckerStatsService } from './services/checker-stats';
import { withTimeout } from './util/with-timeout';
import { createListingService } from './services/listing-service';
import { createCampaignService } from './services/campaign-service';
import { createBalanceService } from './services/balance-service';
import { isModelName, modelRegistry } from './models/registry';
import type { SelectPromoDeps } from './models/select-promo/handle';
import type { ModelResult } from './models/select-promo/types';
import { handleAuction, type AuctionDeps } from './models/auction/handle';
import { handleFeedFill, type FeedFillDeps } from './models/auction/feed-fill';
import { validateAuctionParams, validateFeedFillParams } from './models/auction/validate';
import { handleEnhancePromo, type EnhanceDeps, type CachedSuggestion } from './models/enhance-promo/handle';
import { validateEnhanceParams } from './models/enhance-promo/validate';
import { handleEnhanceBannerImage, type EnhanceBannerImageDeps, type CachedBannerImage } from './models/enhance-banner-image/handle';
import { validateEnhanceBannerImageParams } from './models/enhance-banner-image/validate';
import { createOpenrouterClient } from './services/openrouter-client';
import { createOpenrouterImageClient } from './services/openrouter-image-client';
import { createAiCache } from './services/ai-cache';
import { createRateLimitStore } from './services/rate-limit-store';
import { createCostLog } from './services/cost-log';
import { createChargeService, parseCampaignId, type ChargeService } from './services/charge-service';
import { handleSupportMessage, handleSupportCallback } from './services/support-service';
import metricsPlugin from 'fastify-metrics';

interface ModelsRequestBody {
  models?: unknown;
  params?: unknown;
}

export interface BuildServerOptions {
  authenticator?: Authenticator;
  /** Override service clients (used by tests to inject failing dependencies). */
  deps?: Partial<
    SelectPromoDeps &
      AuctionDeps &
      EnhanceDeps &
      EnhanceBannerImageDeps &
      { chargeService: ChargeService; eventStore: EventStore; analyticsStore: AnalyticsStore; errorStore: ErrorStore }
  >;
  /** Fastify logging; defaults to on. Tests pass false to keep output clean. */
  logger?: boolean;
}

/**
 * Builds the Fastify app. The request chain on POST /models is, in order:
 * parse JSON -> authenticate -> validate -> execute -> respond.
 *
 * HTTP-status policy: request-level failures (malformed JSON, unauthorized,
 * bad/unknown model, invalid params) return the matching 4xx. Once a model
 * actually runs, the response is always HTTP 200 and the per-model envelope's
 * `status` distinguishes ok / skipped / error — so a downed dependency reads as
 * 200 + {status:"error"}, never a 5xx.
 */
/**
 * Real service-ticket auth when a public key is configured (prod); otherwise the stub
 * (any non-empty Authorization header) for local/dev.
 *
 * Fail-closed: in production a missing PROMO_TICKET_PUBLIC_KEY must NOT silently
 * fall back to the stub authenticator — the stub authorizes ANY request carrying a
 * non-empty Authorization header, which would open billing/auction/AI to the public.
 * We refuse to start instead, turning a silent misconfig into a loud crash.
 */
function defaultAuthenticator(): Authenticator {
  if (config.auth.ticketPublicKey) {
    return createTicketAuthenticator({
      publicKey: config.auth.ticketPublicKey,
      expectedDst: config.auth.serviceName,
      allowedSrc: config.auth.allowedSrc,
    });
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'PROMO_TICKET_PUBLIC_KEY is empty: refusing to start in production with stub auth ' +
        '(it authorizes any non-empty Authorization header). Set the Ed25519 public key.',
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    '[auth] PROMO_TICKET_PUBLIC_KEY is empty — using STUB authenticator (any non-empty ' +
      'Authorization header passes). This is for local/dev only; never run prod like this.',
  );
  return createStubAuthenticator();
}

export function buildServer(opts: BuildServerOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? true });

  // Prometheus metrics at /metrics (http_request_duration_seconds by route/status
  // + default process/event-loop metrics). Scraped locally by Prometheus.
  // clearRegisterOnInit: true keeps the global prom-client registry clean when
  // buildServer() is called multiple times in tests (prevents "already registered" errors).
  app.register(metricsPlugin, { endpoint: '/metrics', clearRegisterOnInit: true });
  const authenticator = opts.authenticator ?? defaultAuthenticator();

  // Checker-observability aggregator — counts every checker verdict per promo per
  // queue and batch-writes promo_checker_stats to the AA Supabase once a minute
  // (Grafana "Promo Checkers" dashboard). No-op when AA is unconfigured (dev/tests).
  const checkerStats: CheckerStatsService = opts.deps?.checkerStats ?? createCheckerStatsService({ logger: app.log });
  checkerStats.start();
  app.addHook('onClose', async () => {
    await checkerStats.stop();
  });

  const deps: SelectPromoDeps = {
    configService: createConfigService(app.log),
    userService: createUserService(),
    billingService: createBillingService(),
    impressionStore: createImpressionStore(),
    listingService: createListingService(),
    checkerStats,
    logger: app.log,
    ...opts.deps,
  };

  const auctionDeps: AuctionDeps = {
    campaignService: createCampaignService(),
    balanceService: createBalanceService(),
    logger: app.log,
    ...opts.deps,
  };

  // Feed-fill reuses the auction's campaign + balance services, plus a dedicated
  // feed-frequency service (banner_view_events rolling counts) for the cap. Same
  // test-injection override (opts.deps) as the other dep bundles.
  const feedFillDeps: FeedFillDeps = {
    campaignService: auctionDeps.campaignService,
    balanceService: auctionDeps.balanceService,
    feedFrequencyService: createFeedFrequencyService(),
    logger: app.log,
    ...opts.deps,
  };

  // Singletons for the lifetime of this server instance — cache hits and
  // rate-limit windows have to persist across requests, so they're built once.
  // Text and image AI share rate-limit + cost-log (one budget per advertiser);
  // each has its own cache (different value types).
  const aiRateLimit = createRateLimitStore({
    limit: config.ai.rateLimitPerHour,
    windowMs: 60 * 60 * 1000,
  });
  const aiCostLog = createCostLog({ path: config.ai.costLogPath });

  const enhanceDeps: EnhanceDeps = {
    openrouter: createOpenrouterClient(),
    cache: createAiCache<CachedSuggestion>({ defaultTtlMs: config.ai.cacheTtlMs }),
    rateLimit: aiRateLimit,
    costLog: aiCostLog,
    logger: app.log,
    ...opts.deps,
  };

  const enhanceBannerImageDeps: EnhanceBannerImageDeps = {
    openrouterImage: createOpenrouterImageClient(),
    imageCache: createAiCache<CachedBannerImage>({ defaultTtlMs: config.ai.cacheTtlMs }),
    rateLimit: aiRateLimit,
    costLog: aiCostLog,
    logger: app.log,
    ...opts.deps,
  };

  const chargeService: ChargeService = opts.deps?.chargeService ?? createChargeService();

  // Bug 2 fix — in-process idempotency dedup for campaign charges.
  //
  // Problem: /impressions has no dedup key, so a network retry after a 502 (or a
  // deliberate replay) bills the same campaign twice. The caller supplies an optional
  // `impressionId` nonce; we key a short-TTL Set on "campaignId:userId:nonce" so
  // that replays within the TTL window are no-ops.
  //
  // RESIDUAL RISK: this is process-local — a process restart or multiple BFF
  // instances drop the cache. The correct long-term fix is a DB-level unique index on
  // (campaign_id, user_id, impression_id) inside record_campaign_impression. The
  // nonce is also client-controlled and unsigned; an adversary who varies nonces can
  // still multiply-charge. This guard stops accidental retries / thundering herds.
  //
  // TTL: 60 s — long enough to absorb any realistic network-retry window; short
  // enough that the Map doesn't grow unboundedly on a long-lived process.
  const DEDUP_TTL_MS = 60_000;
  const seenNonces = new Set<string>();
  function tryDedup(key: string): boolean {
    // Returns true when this key was already seen (duplicate → skip charge).
    if (seenNonces.has(key)) return true;
    seenNonces.add(key);
    setTimeout(() => seenNonces.delete(key), DEDUP_TTL_MS).unref?.();
    return false;
  }

  // UX-event sink — writes to abkhaz-auto Supabase (user_action_events).
  // No-op when AA_SUPABASE_URL/KEY env vars are empty (dev/tests).
  const eventStore: EventStore = opts.deps?.eventStore ?? createEventStore();

  // Error sink — writes to abkhaz-auto Supabase (error_events). No-op when unconfigured.
  const errorStore: ErrorStore = opts.deps?.errorStore ?? createErrorStore();

  // Global capture: log (existing behavior) + record to error_events. Only fires on
  // UNHANDLED throws inside handlers (per-route 502s return before throwing).
  app.setErrorHandler<FastifyError>((error, request, reply) => {
    const statusCode = error.statusCode ?? 500;
    app.log.error({ err: error }, `unhandled error: ${request.method} ${request.url}`);
    void errorStore
      .recordError({
        service: config.auth.serviceName,
        source: 'server',
        level: statusCode >= 500 ? 'error' : 'warning',
        message: error.message,
        errorType: error.name,
        stack: error.stack ?? null,
        route: request.url,
        method: request.method,
        statusCode,
        userAgent: (request.headers['user-agent'] as string) ?? null,
      })
      .catch(() => {});
    reply.code(statusCode).send({ error: statusCode >= 500 ? 'internal_error' : 'bad_request' });
  });

  // Analytics RPC reader — читает user_actions_* (миграция 0064) и
  // promo_analytics_* (миграция 0066) из той же AA Supabase. No-op store
  // когда AA не сконфигурена.
  const analyticsStore: AnalyticsStore = opts.deps?.analyticsStore ?? createAnalyticsStore();

  app.post('/models', async (request, reply) => {
    // 1. Parse JSON — Fastify has already parsed the body and auto-400s malformed JSON.
    const requestBody = (request.body ?? {}) as ModelsRequestBody;

    // 2. Authenticate.
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }

    // 3. Validate: models must be a non-empty array of known model names.
    const { models, params } = requestBody;
    if (!Array.isArray(models) || models.length === 0) {
      return reply.code(400).send({ error: 'bad_request', reason: 'models must be a non-empty array' });
    }
    const unknownModels = models.filter((m) => typeof m !== 'string' || !isModelName(m));
    if (unknownModels.length > 0) {
      return reply
        .code(400)
        .send({ error: 'bad_request', reason: `unknown model(s): ${unknownModels.join(', ')}` });
    }

    // 4. Execute every requested model; build the per-model envelope.
    const response: Record<string, ModelResult> = {};
    for (const name of models as string[]) {
      if (!isModelName(name)) continue; // already validated; keeps TS narrow
      const model = modelRegistry[name];
      const validation = model.validate(params);
      if (!validation.ok) {
        return reply.code(400).send({ error: 'bad_request', reason: validation.error });
      }
      response[name] = await model.handle(validation.params, deps);
    }

    // 5. Always 200 here — model-level status lives inside the envelope.
    return reply.code(200).send(response);
  });

  // Records that a user was shown a promo (upserts last-shown timestamp). Same
  // service-ticket auth as /models. Body: { userId, promoId }.
  app.post('/impressions', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }

    const body = (request.body ?? {}) as { userId?: unknown; promoId?: unknown; impressionId?: unknown };
    const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
    const promoId = typeof body.promoId === 'string' ? body.promoId.trim() : '';
    if (!userId || !promoId) {
      return reply
        .code(400)
        .send({ error: 'bad_request', reason: 'userId and promoId are required non-empty strings' });
    }

    const campaignId = parseCampaignId(promoId);
    try {
      if (campaignId !== null) {
        // Bug 2: idempotency guard. If the caller supplies an `impressionId` nonce,
        // build a dedup key and skip the charge on a replay. Missing nonce → charge
        // fires every time (backward-compat), with a logged residual-risk warning.
        const nonce = typeof body.impressionId === 'string' ? body.impressionId.trim() : '';
        if (nonce) {
          const dedupKey = `${campaignId}:${userId}:${nonce}`;
          if (tryDedup(dedupKey)) {
            // Duplicate nonce within the TTL window — idempotent no-op. Return 200
            // so the caller doesn't retry again (a 4xx would trigger another retry).
            app.log.info({ campaignId, userId, nonce }, 'POST /impressions: duplicate nonce, charge skipped');
            return reply.code(200).send({ ok: true });
          }
        } else {
          // No nonce supplied — charge fires, but without a dedup handle we can't
          // prevent accidental retries. Callers should always supply impressionId.
          app.log.warn({ campaignId, userId }, 'POST /impressions: no impressionId nonce — dedup unavailable (residual replay risk)');
        }
        await chargeService.recordCampaignImpression(campaignId, userId);
      } else {
        await deps.impressionStore.recordImpression(userId, promoId);
      }
    } catch (err) {
      app.log.error({ err }, 'POST /impressions: store/charge unavailable');
      return reply.code(502).send({ error: 'impression_store_unavailable' });
    }

    return reply.code(200).send({ ok: true });
  });

  // B2C CPM auction. Separate flow from /models: returns the winning advertiser
  // campaign creative for a slot. Same service-ticket auth + 200-envelope policy.
  app.post('/auction', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }

    const validation = validateAuctionParams(request.body ?? {});
    if (!validation.ok) {
      return reply.code(400).send({ error: 'bad_request', reason: validation.error });
    }

    const result = await handleAuction(validation.params, auctionDeps);
    if (result.status === 'error') {
      return reply.code(200).send(result); // 200-envelope policy; consumer treats non-map as empty
    }
    return reply.code(200).send(result.data);
  });

  // B2C in-feed cascade fill. Returns an ORDERED Advertisement[] (repeats
  // allowed, cpm-weighted), length <= count, for the feed's every-N positions.
  // Same service-ticket auth + 200-envelope policy as /auction.
  app.post('/feed-fill', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }

    const validation = validateFeedFillParams(request.body ?? {});
    if (!validation.ok) {
      return reply.code(400).send({ error: 'bad_request', reason: validation.error });
    }

    const result = await handleFeedFill(validation.params, feedFillDeps);
    if (result.status === 'error') {
      return reply.code(200).send(result); // 200-envelope; consumer treats non-array as empty
    }
    return reply.code(200).send(result.data);
  });

  // AI-assisted promo rewriter. Cabinet sends { advertiserId, draft }; we
  // rate-limit per advertiser, cache identical drafts, log cost. Same service-
  // ticket auth + 200-envelope policy as /models and /auction.
  app.post('/enhance-promo', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }

    const validation = validateEnhanceParams(request.body ?? {});
    if (!validation.ok) {
      return reply.code(400).send({ error: 'bad_request', reason: validation.error });
    }

    const result = await handleEnhancePromo(validation.params, enhanceDeps);
    return reply.code(200).send(result);
  });

  // Image regeneration via Google Nano Banana 2 (gemini-3.1-flash-image-preview).
  // Cabinet sends { advertiserId, imageUrl, width, height, draft:{title?, …} };
  // we craft a render-on-image prompt at the requested dimensions and return
  // the generated image as a base64 data URL inside the envelope.
  app.post('/enhance-banner-image', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const validation = validateEnhanceBannerImageParams(request.body ?? {});
    if (!validation.ok) {
      return reply.code(400).send({ error: 'bad_request', reason: validation.error });
    }
    const result = await handleEnhanceBannerImage(validation.params, enhanceBannerImageDeps);
    return reply.code(200).send(result);
  });

  // UX-event ingestion. Cabinet (abkhaz-auto /api/track) proxies client-side
  // trackEvent beacons here for centralized persistence in user_action_events.
  // Service-ticket auth like every other route. Размерные лимиты валидируются
  // на cabinet-side (там же — bot-фильтр); здесь только shape-check и форвард.
  app.post('/events', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }

    const body = (request.body ?? {}) as {
      eventName?: unknown;
      props?: unknown;
      pagePath?: unknown;
      sessionId?: unknown;
      userId?: unknown;
      userAgent?: unknown;
    };

    const eventName = typeof body.eventName === 'string' ? body.eventName.trim() : '';
    if (!eventName) {
      return reply.code(400).send({ error: 'bad_request', reason: 'eventName required' });
    }

    // props должен быть object — таблица NOT NULL по этой колонке. Пустой
    // объект = {} тоже валиден.
    const props =
      typeof body.props === 'object' && body.props !== null && !Array.isArray(body.props)
        ? (body.props as Record<string, unknown>)
        : {};

    const pagePath = typeof body.pagePath === 'string' ? body.pagePath : null;
    const sessionId = typeof body.sessionId === 'string' ? body.sessionId : null;
    const userId = typeof body.userId === 'string' && body.userId ? body.userId : null;
    const userAgent = typeof body.userAgent === 'string' ? body.userAgent : null;

    try {
      await eventStore.recordEvent({ eventName, props, pagePath, sessionId, userId, userAgent });
    } catch (err) {
      app.log.error({ err }, 'POST /events: event store write failed');
      return reply.code(502).send({ error: 'event_store_unavailable' });
    }

    return reply.code(200).send({ ok: true });
  });

  // Error ingestion. Frontends (abkhaz-auto / cabinet /api/track-error) forward
  // client + server errors here. Same service-ticket auth as /events.
  app.post('/errors', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const b = (request.body ?? {}) as Record<string, unknown>;
    const service = typeof b.service === 'string' ? b.service.trim() : '';
    const message = typeof b.message === 'string' ? b.message.trim().slice(0, 2048) : '';
    if (!service || !message) {
      return reply.code(400).send({ error: 'bad_request', reason: 'service and message required' });
    }
    const ctx = typeof b.context === 'object' && b.context !== null && !Array.isArray(b.context)
      ? (b.context as Record<string, unknown>) : {};
    try {
      await errorStore.recordError({
        service,
        source: typeof b.source === 'string' ? b.source : 'browser',
        level: typeof b.level === 'string' ? b.level : 'error',
        environment: typeof b.environment === 'string' ? b.environment : undefined,
        message,
        errorType: typeof b.errorType === 'string' ? b.errorType : null,
        stack: typeof b.stack === 'string' ? b.stack.slice(0, 16384) : null,
        release: typeof b.release === 'string' ? b.release : null,
        route: typeof b.route === 'string' ? b.route : null,
        method: typeof b.method === 'string' ? b.method : null,
        statusCode: typeof b.statusCode === 'number' ? b.statusCode : null,
        userId: typeof b.userId === 'string' && b.userId ? b.userId : null,
        sessionId: typeof b.sessionId === 'string' ? b.sessionId : null,
        userAgent: typeof b.userAgent === 'string' ? b.userAgent.slice(0, 512) : null,
        context: ctx,
      });
    } catch (err) {
      app.log.error({ err }, 'POST /errors: error store write failed');
      return reply.code(502).send({ error: 'error_store_unavailable' });
    }
    return reply.code(200).send({ ok: true });
  });

  // ── Analytics RPC proxies ───────────────────────────────────────────────
  // Cabinet (/cabinet/analytics) читает агрегаты через эти endpoints вместо
  // прямого доступа к Supabase. Все одинаковые по форме:
  //   - 401 без ticket'а
  //   - 400 на невалидные параметры
  //   - 502 если AA Supabase недоступен
  //   - 200 + { ...result } или { rows: [...] }
  // days clamping одинаковый везде (1..365), limit (1..200) — защита от
  // запросов с case-rare-large _days, которые делают seq scan тяжёлым.

  app.post('/analytics/kpi', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    try {
      const result = await analyticsStore.getKpi();
      return reply.code(200).send(result);
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/kpi failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  app.post('/analytics/top', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { days?: unknown; limit?: unknown };
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 7;
    const limit = typeof body.limit === 'number' && body.limit > 0 && body.limit <= 200 ? body.limit : 25;
    try {
      const rows = await analyticsStore.getTop(days, limit);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/top failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  app.post('/analytics/daily', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { days?: unknown };
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    try {
      const rows = await analyticsStore.getDaily(days);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/daily failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  app.post('/analytics/funnel', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { events?: unknown; days?: unknown };
    if (
      !Array.isArray(body.events) ||
      body.events.length === 0 ||
      body.events.some((e) => typeof e !== 'string' || !e)
    ) {
      return reply.code(400).send({ error: 'bad_request', reason: 'events must be a non-empty string[]' });
    }
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    try {
      const rows = await analyticsStore.getFunnel(body.events as string[], days);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/funnel failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  // Promo-specific (миграция 0066 на AA Supabase).
  app.post('/analytics/promos/top', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { days?: unknown; limit?: unknown };
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    const limit = typeof body.limit === 'number' && body.limit > 0 && body.limit <= 200 ? body.limit : 25;
    try {
      const rows = await analyticsStore.getPromoTop(days, limit);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/promos/top failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  app.post('/analytics/promos/zero', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { days?: unknown; limit?: unknown };
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    const limit = typeof body.limit === 'number' && body.limit > 0 && body.limit <= 200 ? body.limit : 25;
    try {
      const rows = await analyticsStore.getPromoZero(days, limit);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/promos/zero failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  app.post('/analytics/promos/funnel-by-format', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { days?: unknown };
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    try {
      const rows = await analyticsStore.getPromoFunnelByFormat(days);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/promos/funnel-by-format failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  // Onboarding analytics (миграция 0067 на AA Supabase).
  app.post('/analytics/onboarding/overview', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { days?: unknown };
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    try {
      const result = await analyticsStore.getOnboardingOverview(days);
      return reply.code(200).send(result);
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/onboarding/overview failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  app.post('/analytics/onboarding/funnel', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { days?: unknown };
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    try {
      const rows = await analyticsStore.getOnboardingFunnel(days);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/onboarding/funnel failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  app.post('/analytics/promos/timeline', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const body = (request.body ?? {}) as { promo_id?: unknown; days?: unknown };
    if (typeof body.promo_id !== 'string' || !body.promo_id.trim()) {
      return reply.code(400).send({ error: 'bad_request', reason: 'promo_id required' });
    }
    const days = typeof body.days === 'number' && body.days > 0 && body.days <= 365 ? body.days : 30;
    try {
      const rows = await analyticsStore.getPromoTimeline(body.promo_id, days);
      return reply.code(200).send({ rows });
    } catch (err) {
      app.log.error({ err }, 'POST /analytics/promos/timeline failed');
      return reply.code(502).send({ error: 'analytics_unavailable' });
    }
  });

  // ─── AI support (claudeclaw relay) ──────────────────────────────────────
  // The abkhaz-auto site calls these cross-origin with the user's Supabase
  // access token. CORS for the site origin; OPTIONS preflight short-circuits.
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.startsWith('/support/')) {
      reply.header('Access-Control-Allow-Origin', config.support.siteOrigin);
      reply.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
      reply.header('Access-Control-Allow-Headers', 'content-type, authorization');
      if (request.method === 'OPTIONS') {
        reply.code(204).send();
      }
    }
  });

  app.post('/support/message', async (request, reply) => {
    const auth = (request.headers['authorization'] as string) ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    const body = (request.body ?? {}) as { message?: unknown };
    const result = await handleSupportMessage(token, body.message);
    if (!result.ok) return reply.code(result.status).send({ error: result.error });
    return reply.send({ ok: true, conversationId: result.conversationId, message: result.message });
  });

  app.post('/support/callback', async (request, reply) => {
    // claudeclaw signs JSON.stringify({conversationId,reply,escalate}); Fastify
    // re-stringifies the same fixed shape byte-identically, so HMAC matches.
    const sig = (request.headers['x-signature'] as string) ?? '';
    const raw = JSON.stringify(request.body ?? {});
    const result = await handleSupportCallback(raw, sig);
    return reply.code(result.status).send({ ok: result.ok });
  });

  // Liveness + readiness probes (unauthenticated — for the orchestrator, not data).
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/ready', async (_request, reply) => {
    const { url } = config.aaSupabase;
    if (!url) return { status: 'ok', note: 'aa-supabase unconfigured' };
    try {
      await withTimeout(fetch(`${url}/rest/v1/`, { method: 'HEAD' }), 2000, 'ready');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}

// Start the server only when this file is run directly (not when imported by tests).
const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const app = buildServer();
  const processErrorStore = createErrorStore();
  const recordFatal = (err: unknown, kind: string) =>
    processErrorStore
      .recordError({
        service: config.auth.serviceName,
        source: 'process',
        level: 'fatal',
        message: err instanceof Error ? err.message : String(err),
        errorType: kind,
        stack: err instanceof Error ? (err.stack ?? null) : null,
      })
      .catch(() => {});

  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, 'unhandledRejection');
    void recordFatal(reason, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    app.log.error({ err }, 'uncaughtException');
    void recordFatal(err, 'uncaughtException').finally(() => process.exit(1));
  });

  app.listen({ port: config.port, host: config.host }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
