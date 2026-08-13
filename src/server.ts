import Fastify, { type FastifyInstance, type FastifyError, type FastifyReply } from 'fastify';
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
import { createReferralConfigService, type ReferralConfigService } from './services/referral-config-service';
import { createAnalyticsStore, type AnalyticsStore } from './services/analytics-store';
import { createAaAdminStore, type AaAdminStore } from './services/aa-admin-store';
import { createCheckerStatsService, type CheckerStatsService } from './services/checker-stats';
import { createSelectionTraceService, type SelectionTraceService } from './services/selection-trace';
import { withTimeout } from './util/with-timeout';
import { createListingService } from './services/listing-service';
import { createSearchHistoryService } from './services/search-history-service';
import { createPurchaseLedgerService } from './services/purchase-ledger-service';
import { createCampaignService } from './services/campaign-service';
import { createBalanceService } from './services/balance-service';
import { isModelName, modelRegistry } from './models/registry';
import type { SelectPromoDeps } from './models/select-promo/handle';
import { handleSelectPromoList } from './models/select-promo/handle-list';
import { validateParams as validateSelectPromoParams } from './models/select-promo/validate';
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
import { createIdentityProofVerifier, type IdentityProofVerifier } from './identity-proof';

interface ModelsRequestBody {
  models?: unknown;
  params?: unknown;
}

export interface BuildServerOptions {
  authenticator?: Authenticator;
  /** Test/embedding override; production derives this from service-ticket config. */
  identityProofVerifier?: IdentityProofVerifier;
  /** Override service clients (used by tests to inject failing dependencies). */
  deps?: Partial<
    SelectPromoDeps &
      AuctionDeps &
      EnhanceDeps &
      EnhanceBannerImageDeps &
      {
        chargeService: ChargeService;
        eventStore: EventStore;
        analyticsStore: AnalyticsStore;
        errorStore: ErrorStore;
        referralConfigService: ReferralConfigService;
        /** test/prod пара — держим оба стора, роут резолвит нужный по body.env. */
        aaAdminStores: Record<'test' | 'prod', AaAdminStore>;
      }
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
  const identityProofVerifier = opts.identityProofVerifier ?? (
    config.auth.ticketPublicKey
      ? createIdentityProofVerifier({
          publicKey: config.auth.ticketPublicKey,
          expectedDst: config.auth.serviceName,
        })
      : undefined
  );

  // Checker-observability aggregator — counts every checker verdict per promo per
  // queue and batch-writes promo_checker_stats to the AA Supabase once a minute
  // (Grafana "Promo Checkers" dashboard). No-op when AA is unconfigured (dev/tests).
  const checkerStats: CheckerStatsService = opts.deps?.checkerStats ?? createCheckerStatsService({ logger: app.log });
  checkerStats.start();
  app.addHook('onClose', async () => {
    await checkerStats.stop();
  });

  // Per-request selection trace — one row per select-promo walk with userId +
  // excludeIds + the full per-checker verdicts (promo_selection_traces on the AA
  // Supabase, Grafana "Трейс запроса" drill-down). Complements the anonymous
  // checker-stats aggregate. No-op when AA is unconfigured (dev/tests).
  const selectionTrace: SelectionTraceService = opts.deps?.selectionTrace ?? createSelectionTraceService({ logger: app.log });
  selectionTrace.start();
  app.addHook('onClose', async () => {
    await selectionTrace.stop();
  });

  const deps: SelectPromoDeps = {
    configService: createConfigService(app.log),
    userService: createUserService(),
    billingService: createBillingService(),
    impressionStore: createImpressionStore(),
    listingService: createListingService(),
    searchHistoryService: createSearchHistoryService(),
    purchaseLedgerService: createPurchaseLedgerService(),
    balanceService: createBalanceService(),
    checkerStats,
    selectionTrace,
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

  // Referral-config mirror — upserts abkhaz-auto Supabase referral_config
  // (id=1) whenever the cabinet saves its referral-invite custom promo.
  // No-op when AA Supabase is unconfigured (dev/tests).
  const referralConfigService: ReferralConfigService =
    opts.deps?.referralConfigService ?? createReferralConfigService();

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

  // Пульт канарейки/экспериментов abkhaz-auto (/aa-admin/*) — два независимых
  // Supabase-стенда (test/prod), каждый запрос сам выбирает env в теле. Оба
  // стора строятся заранее (дёшево — просто замыкание над fetch), а не по
  // запросу, чтобы не плодить объекты на каждый POST.
  const aaAdminStores: Record<'test' | 'prod', AaAdminStore> = opts.deps?.aaAdminStores ?? {
    test: createAaAdminStore(config.aaTestSupabase),
    prod: createAaAdminStore(config.aaSupabase),
  };

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
      const validation = model.validate(params, {
        verifyIdentityProof: identityProofVerifier && auth.clientId
          ? (proof, expectedSub) => identityProofVerifier.verify(proof, expectedSub, auth.clientId as string)
          : undefined,
      });
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

  // Onboarding tour: the WHOLE ordered, eligibility-filtered sequence in one call
  // ({ status, steps }), played by the storefront as a client cursor. Sibling of
  // /auction — same service-ticket auth + 200-envelope policy — so the generic
  // /models envelope + modelRegistry stay untouched. Reuses select-promo's params
  // validator (userId/queue/device/skipCheckers) and the shared SelectPromoDeps.
  app.post('/promo-list', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }

    const validation = validateSelectPromoParams(request.body ?? {}, {
      verifyIdentityProof: identityProofVerifier && auth.clientId
        ? (proof, expectedSub) => identityProofVerifier.verify(proof, expectedSub, auth.clientId as string)
        : undefined,
    });
    if (!validation.ok) {
      return reply.code(400).send({ error: 'bad_request', reason: validation.error });
    }

    // Full envelope so the consumer can tell ok (steps) from skipped/error (→ []).
    const result = await handleSelectPromoList(validation.params, deps);
    return reply.code(200).send(result);
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

  // Referral-config mirror. The cabinet's referral-invite custom promo is a
  // config-only promo (nothing renders on the storefront) — its fields must
  // additionally land in abkhaz-Supabase's referral_config singleton (id=1),
  // which only the BFF can reach. Called by the cabinet's server-side
  // /api/referral-config/sync route AFTER the promo is already durably saved
  // to its own S3 pool, so a failure here is reported as a 502 but the
  // cabinet treats it as best-effort (see promo-cabinet's route doc) — it
  // does not roll back or retry the S3 save.
  app.post('/referral-config/sync', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    }
    const b = (request.body ?? {}) as Record<string, unknown>;
    const active = Boolean(b.active);
    const inviterCreditKopecks = Number(b.inviterCreditKopecks);
    const sellerBonusKopecks = Number(b.sellerBonusKopecks);
    const dailyInviteCap = Number(b.dailyInviteCap);
    const holdHours = Number(b.holdHours);
    const dailyBudgetKopecks = Number(b.dailyBudgetKopecks);
    if (
      !Number.isInteger(inviterCreditKopecks) || inviterCreditKopecks < 0 ||
      !Number.isInteger(sellerBonusKopecks) || sellerBonusKopecks < 0 ||
      !Number.isInteger(dailyInviteCap) || dailyInviteCap <= 0 ||
      !Number.isInteger(holdHours) || holdHours < 0 ||
      !Number.isInteger(dailyBudgetKopecks) || dailyBudgetKopecks < 0
    ) {
      return reply.code(400).send({ error: 'bad_request', reason: 'invalid referral config fields' });
    }
    try {
      await referralConfigService.sync({ active, inviterCreditKopecks, sellerBonusKopecks, dailyInviteCap, holdHours, dailyBudgetKopecks });
    } catch (err) {
      app.log.error({ err }, 'POST /referral-config/sync: upsert failed');
      return reply.code(502).send({ error: 'referral_config_unavailable' });
    }
    return reply.code(200).send({ ok: true });
  });

  // ── Analytics: единственный выживший из десятка RPC-прокси ──────────────
  // Инициатива «Метрика — единственный источник продуктовой аналитики»
  // (2026-07): агрегатные дашборды кабинета снесены (promo-cabinet PR #3),
  // а с ними умерли и питавшие их ручки /analytics/{kpi,top,daily,funnel,
  // promos/*,onboarding/*}. Мёртвые эндпоинты удалены 2026-07-27 — «безвредная»
  // ручка с service-role-доступом к БД это не удобство, а поверхность атаки.
  // Остался таймлайн показов конкретной промки: его читает PromoAnalyticsBlock
  // на /cabinet/[id]. Форма ответа: 401 без тикета, 400 на невалидные
  // параметры, 502 если AA Supabase недоступен, 200 + { rows }. days clamp
  // 1..365 — защита от запросов, делающих seq scan тяжёлым.

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

  // ── aa-admin: пульт канарейки релиза и A/B-экспериментов abkhaz-auto ─────
  // Перенос серверных экшенов витрины (src/app/admin/experiments/actions.ts)
  // в BFF — кабинет получает управление обоими стендами (test/prod) без
  // прямого service-role доступа к их Supabase из браузера. Тикет-auth, как у
  // остальных ручек; каждый запрос указывает env явно (никакого «дефолтного»
  // окружения — цена ошибки здесь prod-канарейка или прод-эксперимент).
  //
  // НЕ перенесено: forceVariant (кука aa_exp_force в браузере витрины для
  // QA-залипания в вариант) — она держит состояние в cookie jar того же
  // рендера, что и middleware, читающий флаги; вне процесса витрины ставить
  // эту куку некому и незачем.
  type AaEnv = 'test' | 'prod';

  function resolveAaAdminStore(
    body: Record<string, unknown>,
    reply: FastifyReply,
  ): { store: AaAdminStore; env: AaEnv } | null {
    const env = body.env;
    if (env !== 'test' && env !== 'prod') {
      reply.code(400).send({ error: 'bad_request', reason: 'env must be "test" or "prod"' });
      return null;
    }
    const store = aaAdminStores[env];
    // configured берём со стора (а не заново читаем config.aa*Supabase) —
    // так тесты, подсовывающие свой aaAdminStores через deps, не зависят от
    // реального process.env, а прод-код видит тот же факт, что уже решил
    // createAaAdminStore при старте.
    if (!store.configured) {
      reply.code(503).send({ error: 'env_not_configured', env });
      return null;
    }
    return { store, env };
  }

  app.post('/aa-admin/canary/state', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    try {
      const row = await resolved.store.getCanaryState();
      return reply.code(200).send(
        row ?? { colour: null, pct: 0, updated_at: null, updated_by: null },
      );
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/canary/state failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
  });

  // pct: целое 0..99 (0 = стоп раздачи кук, канарейка сама остаётся
  // сконфигурена на сервере); colour пишет только bluegreen.sh — если он
  // NULL, менять нечего (409, а не тихий no-op).
  app.post('/aa-admin/canary/pct', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    const pctRaw = body.pct;
    if (typeof pctRaw !== 'number' || !Number.isInteger(pctRaw) || pctRaw < 0 || pctRaw > 99) {
      return reply.code(400).send({ error: 'bad_request', reason: 'pct must be an integer 0..99' });
    }
    const actor = auth.clientId ?? 'promo-cabinet';
    try {
      const result = await resolved.store.setCanaryPct(pctRaw, actor);
      if (!result.ok) {
        // Store различает «отказ семантики» (ok:false — плохой pct/colour
        // IS NULL/PostgREST 4xx) от «Supabase недоступна» (throw, catch ниже).
        // Первое — по ТЗ 409 canary_not_active; сюда же попадёт неожиданный
        // 4xx от PostgREST, но такое требует расхождения со схемой БД, не
        // штатный кейс, отдельного кода под него не заводим.
        return reply.code(409).send({ error: 'canary_not_active', reason: result.error });
      }
      return reply.code(200).send({ ok: true });
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/canary/pct failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
  });

  app.post('/aa-admin/experiments/list', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    try {
      const { experiments, variants } = await resolved.store.listExperiments();
      return reply.code(200).send({ experiments, variants });
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/experiments/list failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
  });

  // Тело: { env, key, title, surface: 'client'|'dynamic', variants: [{key,
  // weight, is_control}] }. Валидации зеркалят createExperiment из actions.ts
  // (kebab-case ключ, ≥2 варианта, ровно нужен control, уникальные ключи).
  app.post('/aa-admin/experiments/create', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    const { key, title, surface, variants } = body as {
      key?: unknown;
      title?: unknown;
      surface?: unknown;
      variants?: unknown;
    };
    if (typeof key !== 'string' || typeof title !== 'string' || typeof surface !== 'string' || !Array.isArray(variants)) {
      return reply.code(400).send({ error: 'bad_request', reason: 'key, title, surface, variants[] required' });
    }
    const variantsInput = variants.map((v) => ({
      key: typeof (v as { key?: unknown })?.key === 'string' ? (v as { key: string }).key : '',
      weight: Number((v as { weight?: unknown })?.weight),
      is_control: !!(v as { is_control?: unknown })?.is_control,
    }));
    try {
      const result = await resolved.store.createExperiment({ key, title, surface, variants: variantsInput });
      if (!result.ok) return reply.code(400).send({ error: 'bad_request', reason: result.error });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/experiments/create failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
  });

  // Тело: { env, id (= experiment key), patch: { rollout_pct?, status?,
  // kill_switch?, surface?, authOnly? } }. `id` — имя как в остальных ручках
  // проекта (не совпадает с полем в БД, там это `key`) — store принимает его
  // как ключ эксперимента.
  app.post('/aa-admin/experiments/patch', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    const { id, patch } = body as { id?: unknown; patch?: unknown };
    if (typeof id !== 'string' || !id.trim() || typeof patch !== 'object' || patch === null) {
      return reply.code(400).send({ error: 'bad_request', reason: 'id and patch required' });
    }
    try {
      const result = await resolved.store.patchExperiment(id, patch as Record<string, unknown>);
      if (!result.ok) return reply.code(400).send({ error: 'bad_request', reason: result.error });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/experiments/patch failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
  });

  // Тело: { env, id (= experiment key) }. Перебакетирует всех зрителей заново.
  app.post('/aa-admin/experiments/bump-salt', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    const { id } = body as { id?: unknown };
    if (typeof id !== 'string' || !id.trim()) {
      return reply.code(400).send({ error: 'bad_request', reason: 'id required' });
    }
    try {
      const result = await resolved.store.bumpSalt(id);
      if (!result.ok) return reply.code(400).send({ error: 'bad_request', reason: result.error });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/experiments/bump-salt failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
  });

  // Тело: { env, expKey, from, to }. `to` должен быть kebab-case (или
  // литерал "control"), как в actions.ts renameVariant.
  app.post('/aa-admin/experiments/rename-variant', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    const { expKey, from, to } = body as { expKey?: unknown; from?: unknown; to?: unknown };
    if (typeof expKey !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
      return reply.code(400).send({ error: 'bad_request', reason: 'expKey, from, to required' });
    }
    try {
      const result = await resolved.store.renameVariant(expKey, from, to);
      if (!result.ok) return reply.code(400).send({ error: 'bad_request', reason: result.error });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/experiments/rename-variant failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
  });

  // Тело: { env, id (= experiment key), weights: [{key, weight}] }.
  app.post('/aa-admin/experiments/variant-weights', async (request, reply) => {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) return reply.code(401).send({ error: 'unauthorized', reason: auth.reason ?? 'unauthorized' });
    const body = (request.body ?? {}) as Record<string, unknown>;
    const resolved = resolveAaAdminStore(body, reply);
    if (!resolved) return;
    const { id, weights } = body as { id?: unknown; weights?: unknown };
    if (typeof id !== 'string' || !id.trim() || !Array.isArray(weights)) {
      return reply.code(400).send({ error: 'bad_request', reason: 'id and weights[] required' });
    }
    const weightsInput = weights.map((w) => ({
      key: typeof (w as { key?: unknown })?.key === 'string' ? (w as { key: string }).key : '',
      weight: Number((w as { weight?: unknown })?.weight),
    }));
    try {
      const result = await resolved.store.saveVariantWeights(id, weightsInput);
      if (!result.ok) return reply.code(400).send({ error: 'bad_request', reason: result.error });
      return reply.code(200).send({ ok: true });
    } catch (err) {
      app.log.error({ err }, 'POST /aa-admin/experiments/variant-weights failed');
      return reply.code(502).send({ error: 'aa_admin_unavailable' });
    }
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
