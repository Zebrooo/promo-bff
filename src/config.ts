/**
 * App configuration. Timeouts for external services and S3 catalogue settings live
 * here so they can be tuned without touching the service clients.
 */

export interface ServiceTimeouts {
  configServiceMs: number;
  userServiceMs: number;
  billingServiceMs: number;
}

export interface S3Config {
  /** S3 bucket name. Holds promos.json, queues.json and queue-<name>.json. Empty until the user provisions it. */
  bucket: string;
  region: string;
  /** Optional key prefix (e.g. "promos/"). Empty = bucket root. */
  keyPrefix: string;
  /** S3-compatible endpoint (bucket.ru). Empty = default AWS endpoints. */
  endpoint: string;
  /** Path-style addressing — required by bucket.ru and most non-AWS S3 stores. */
  forcePathStyle: boolean;
}

export interface AuthConfig {
  /** base64 DER SPKI Ed25519 public key for verifying service tickets. Empty = stub auth (dev). */
  ticketPublicKey: string;
  /** This service's id — incoming tickets must target it (`dst`). */
  serviceName: string;
  /** Service ids allowed to call us (ticket `src`). */
  allowedSrc: string[];
}

export interface SupabaseConfig {
  /** Supabase REST base URL (PostgREST behind Kong). Empty = no-op store (dev). */
  url: string;
  /** service-role JWT; used as both apikey and Bearer. Empty = no-op store (dev). */
  serviceRoleKey: string;
  /** Timeout for impression reads/writes. */
  timeoutMs: number;
}

export interface OpenrouterConfig {
  /** OpenRouter API key. Empty = client throws on call (config error). */
  apiKey: string;
  /** Default model id (e.g. "openai/gpt-4o-mini"). Per-call override is allowed. */
  defaultModel: string;
  /** Pricing for cost-log: USD per 1M prompt tokens. Defaults are placeholders —
   *  verify on openrouter.ai/<model> before relying on numbers. */
  pricePerMillionIn: number;
  pricePerMillionOut: number;
  /** USD → RUB rate used to convert the cost into roubles for the log. */
  usdRub: number;
  /** Hard cap per single call. Banner copy is small; 30s is generous. */
  timeoutMs: number;
}

export interface OpenrouterImageConfig {
  apiKey: string;
  imageModel: string;
  pricePerImageUsd: number;
  usdRub: number;
  timeoutMs: number;
}

export interface AiConfig {
  /** Max enhance requests per advertiser per rolling hour. */
  rateLimitPerHour: number;
  /** How long an enhanced result is cached for the same draft+actor. */
  cacheTtlMs: number;
  /** Where to append the JSONL cost log. */
  costLogPath: string;
}

export interface AppConfig {
  port: number;
  host: string;
  serviceTimeouts: ServiceTimeouts;
  s3: S3Config;
  auth: AuthConfig;
  /** Promo Supabase — holds promo_impressions, charge ledger, queue meta.
   *  Currently = promo-cabinet Supabase (eremin.site stack). */
  supabase: SupabaseConfig;
  /** abkhaz-auto Supabase — holds user_action_events (UX analytics) and
   *  the user_actions_* aggregate RPCs. Distinct deployment from the promo
   *  Supabase: BFF needs creds for both to bridge analytics. */
  aaSupabase: SupabaseConfig;
  /** abkhaz-auto TEST Supabase — отдельный деплой стенда (canary_state/experiments
   *  там тоже свои). /aa-admin/* ручки резолвят env:'test'|'prod' в этот конфиг
   *  или в aaSupabase, чтобы пульт канарейки/экспериментов не мог случайно
   *  задеть прод, работая со стендом (и наоборот). */
  aaTestSupabase: SupabaseConfig;
  support: SupportConfig;
  openrouter: OpenrouterConfig;
  openrouterImage: OpenrouterImageConfig;
  ai: AiConfig;
}

export interface SupportConfig {
  claudeclawWebhookUrl: string;
  webhookSecret: string;
  callbackSecret: string;
  siteOrigin: string;
  ratePerHour: number;
  supabaseTimeoutMs: number;
}

export const config: AppConfig = {
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '0.0.0.0',
  serviceTimeouts: {
    configServiceMs: Number(process.env.CONFIG_TIMEOUT_MS ?? 2500),
    userServiceMs: Number(process.env.USER_TIMEOUT_MS ?? 2500),
    billingServiceMs: Number(process.env.BILLING_TIMEOUT_MS ?? 2500),
  },
  s3: {
    bucket: process.env.PROMO_BUCKET ?? '',
    region: process.env.AWS_REGION ?? 'us-east-1',
    keyPrefix: process.env.PROMO_KEY_PREFIX ?? '',
    endpoint: process.env.PROMO_S3_ENDPOINT ?? '',
    forcePathStyle: process.env.PROMO_S3_FORCE_PATH_STYLE !== 'false',
  },
  auth: {
    ticketPublicKey: process.env.PROMO_TICKET_PUBLIC_KEY ?? '',
    serviceName: process.env.PROMO_SERVICE_NAME ?? 'promo-bff',
    allowedSrc: (process.env.PROMO_ALLOWED_SRC ?? 'abkhaz-auto')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
  supabase: {
    url: (process.env.PROMO_SUPABASE_URL ?? '').replace(/\/$/, ''),
    serviceRoleKey: process.env.PROMO_SUPABASE_SERVICE_ROLE_KEY ?? '',
    timeoutMs: Number(process.env.PROMO_SUPABASE_TIMEOUT_MS ?? 2500),
  },
  aaSupabase: {
    // abkhaz-auto Supabase (e.g., https://supabase-aa.apsoftgroup.ru).
    // Same shape as promo Supabase — service-role key, REST timeout.
    url: (process.env.AA_SUPABASE_URL ?? '').replace(/\/$/, ''),
    serviceRoleKey: process.env.AA_SUPABASE_SERVICE_ROLE_KEY ?? '',
    timeoutMs: Number(process.env.AA_SUPABASE_TIMEOUT_MS ?? 2500),
  },
  aaTestSupabase: {
    // abkhaz-auto TEST-стенд — отдельная Supabase-инсталляция, отдельные creds.
    // Пусто, если стенд не поднят/не сконфигурен на этом деплое BFF.
    url: (process.env.AA_TEST_SUPABASE_URL ?? '').replace(/\/$/, ''),
    serviceRoleKey: process.env.AA_TEST_SUPABASE_SERVICE_ROLE_KEY ?? '',
    timeoutMs: Number(process.env.AA_TEST_SUPABASE_TIMEOUT_MS ?? 2500),
  },
  support: {
    // AI support backend: relays site users' messages to the local claudeclaw
    // agent and ingests its callback. Both legs are HMAC-signed.
    claudeclawWebhookUrl:
      process.env.CLAUDECLAW_WEBHOOK_URL ?? 'http://127.0.0.1:8791/webhook/support',
    webhookSecret: process.env.CLAUDECLAW_WEBHOOK_SECRET ?? '',
    callbackSecret: process.env.SUPPORT_CALLBACK_SECRET ?? '',
    siteOrigin: process.env.SUPPORT_SITE_ORIGIN ?? 'https://abkhaz-auto.apsoftgroup.ru',
    ratePerHour: Number(process.env.SUPPORT_RATE_PER_HOUR ?? 20),
    // Writes to abkhaz-auto Supabase cross-server (promo → apsoft1) — must NOT
    // reuse the ad system's fast-fail 2.5s timeout, or the bot reply is lost.
    supabaseTimeoutMs: Number(process.env.SUPPORT_SUPABASE_TIMEOUT_MS ?? 10000),
  },
  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    defaultModel: process.env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
    pricePerMillionIn: Number(process.env.OPENROUTER_USD_PER_M_IN ?? 0.15),
    pricePerMillionOut: Number(process.env.OPENROUTER_USD_PER_M_OUT ?? 0.60),
    usdRub: Number(process.env.OPENROUTER_USD_RUB ?? 95),
    timeoutMs: Number(process.env.OPENROUTER_TIMEOUT_MS ?? 30000),
  },
  openrouterImage: {
    // Reuses the same API key as the chat model.
    apiKey: process.env.OPENROUTER_API_KEY ?? '',
    // Default = Google "Nano Banana 2" (text+image→image). Override via env.
    imageModel: process.env.OPENROUTER_IMAGE_MODEL ?? 'google/gemini-3.1-flash-image-preview',
    // Image-gen models bill per output image; placeholder default. Tune via env.
    pricePerImageUsd: Number(process.env.OPENROUTER_IMAGE_USD ?? 0.04),
    usdRub: Number(process.env.OPENROUTER_USD_RUB ?? 95),
    // Image gen often takes 20-40s. Give it room.
    timeoutMs: Number(process.env.OPENROUTER_IMAGE_TIMEOUT_MS ?? 60000),
  },
  ai: {
    rateLimitPerHour: Number(process.env.AI_RATE_LIMIT_PER_HOUR ?? 30),
    cacheTtlMs: Number(process.env.AI_CACHE_TTL_MS ?? 10 * 60 * 1000),
    costLogPath: process.env.AI_COST_LOG_PATH ?? './tmp/ai-cost.log',
  },
};
