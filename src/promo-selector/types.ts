/** Domain types for promo selection. */

export type SubscriptionLevel = 'none' | 'plus' | 'premium';

export type PromoFormat = 'inline' | 'popup' | 'fullscreen' | 'topline' | 'banner' | 'divkit' | 'tooltip' | 'multistep' | 'custom';

export type PromoOs = 'ios' | 'android';
export type PromoEnvironment = 'browser' | 'telegram' | 'pwa' | 'app';
export type DeviceBrand = 'iphone' | 'android-flagship' | 'android-other';

/**
 * Env-сигнал запроса: enum-классы среды исполнения, вычисленные СЕРВЕРОМ САЙТА
 * из UA и кук (aa_app/aa_env). Сырой UA в BFF не передаётся (приватность, спека §6).
 * runtime поименован так (а не environment), чтобы не путать с массивом правил
 * targeting.environments.
 *
 * ⚠️ Сигнал НЕДОВЕРЕННЫЙ: куки/UA полностью подконтрольны клиенту
 * (document.cookie='aa_env=telegram' — и посетитель «в Telegram»). Годится
 * только для маркетингового таргетинга показов; НЕ строить на нём выдачу
 * наград, бонусов и любых бюджетно-гарантированных механик.
 */
export interface PromoEnvSignal {
  os?: PromoOs;
  runtime?: PromoEnvironment;
  brand?: DeviceBrand;
}

/** IP-гео сегмент «где пользователь СЕЙЧАС», разрезолвленный сайтом (не сырой IP). */
export type GeoSegment = 'local' | 'tourist' | 'other';

/** Класс источника захода текущей сессии (aa_src, свёрнут сайтом до 4 значений). */
export type EntrySource = 'direct' | 'search' | 'telegram' | 'other';

export interface ImageFocalPoint {
  /** Horizontal coordinate in basis points: 0 = left, 10_000 = right. */
  xBp: number;
  /** Vertical coordinate in basis points: 0 = top, 10_000 = bottom. */
  yBp: number;
}

export interface PromoTargeting {
  minAge?: number;
  maxAge?: number;
  /** Allowed regions; empty/omitted means "all regions". */
  regions?: string[];
  /** Allowed subscription levels; empty/omitted means "any level". */
  subscriptionLevels?: SubscriptionLevel[];
  /** Allowed OS classes; empty/omitted = any. Desktop carries no OS class → fail-closed. */
  os?: PromoOs[];
  /** Allowed execution environments; empty/omitted = any. */
  environments?: PromoEnvironment[];
  /** Allowed device-brand classes (платёжеспособность-прокси по UA); empty/omitted = any. */
  deviceBrands?: DeviceBrand[];
  /** IP-гео: допустимые сегменты «где сейчас». Пусто/нет = любой. НЕ regions: та ось — город из ПРОФИЛЯ. */
  geoSegments?: GeoSegment[];
  /** IP-гео: допустимые города (слаги, та же номенклатура, что profiles.city). Пусто/нет = любой. */
  geoCities?: string[];
  /** 'newcomer' | 'regular'; нет поля = любой посетитель (VisitorChecker скипается). */
  visitorClass?: 'newcomer' | 'regular';
  /** Только при visitorClass='newcomer'; дефолт 7 (DEFAULT_NEWCOMER_MAX_AGE_DAYS). */
  newcomerMaxAgeDays?: number;
  /** Только при visitorClass='regular'; дефолт 5 (DEFAULT_REGULAR_MIN_VISIT_DAYS). */
  regularMinVisitDays?: number;
  /** Search-history gate. Omitted/empty means no search targeting. */
  search?: {
    /** Normalized phrases to find in past search queries. */
    terms?: string[];
    /** Search sections to allow (exact match after normalization). */
    sections?: string[];
    /** Whether any term or every term must be present. Defaults to `any`. */
    match?: 'any' | 'all';
    /** Rolling history window. Defaults to 30 days. */
    lookbackDays?: number;
  };
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
  /** Поведенческий гейт: интересы/горячий покупатель/вовлечённость визита.
   *  Между условиями — AND (как между чекерами), внутри categories — OR.
   *  Omitted/empty = no behavior targeting. */
  behavior?: {
    /** Смотрел объявления этих категорий (slug'и categories сайта) за lookbackDays. */
    interest?: {
      categories?: string[];
      /** 1..14: потолок = окно RPC promo_viewer_behavior. Дефолт чекера 7. */
      lookbackDays?: number;
    };
    /** Открывал телефоны ≥ minPhoneViews РАЗНЫХ объявлений за 7 дней (окно фикс. в RPC). */
    hotBuyer?: { minPhoneViews?: number };
    /** Показывать только после N открытых карточек за текущий визит. */
    minSessionViews?: number;
  };
  /** Own-listings gate: categories/active-categories/upsell/reactivation. Omitted/empty means no listings targeting. */
  listings?: {
    /** Ever listed (any status) in one of these category slugs. */
    categories?: string[];
    /** Whether categories/activeCategories require ANY or ALL to match. Defaults to `any`. */
    categoriesMatch?: 'any' | 'all';
    /** Has an ACTIVE listing in one of these category slugs. */
    activeCategories?: string[];
    /** Has an active listing without current promotion (upsell gate). */
    hasUnpromotedActive?: boolean;
    /** Minimum days since the user's most recent listing (any status). */
    inactiveDays?: number;
  };
}

/**
 * Таргетинг по стадии жизненного цикла СОБСТВЕННЫХ объявлений зрителя
 * (LifecycleChecker). Все заданные условия объединяются по И; нужен «ИЛИ» —
 * заводится два промо. Server-only: клиенту не отдаётся (stripToAdvertisement).
 */
export interface PromoLifecycle {
  /** (а) Есть АКТИВНОЕ объявление хотя бы в одной из категорий (slug'и, ≥1). */
  activeInCategories?: string[];
  /** (б) Перевёл объявление в sold за последние N дней (1..90). */
  soldWithinDays?: number;
  /** (в) Есть активное 30+ дней с малым числом просмотров (пороги — константы BFF). */
  hasStalledActive?: true;
  /** (г) Ровно одно объявление за всю историю, и оно свежее N дней (1..30). */
  firstListingWithinDays?: number;
}

/** Dayparting: показ только в выбранные дни недели и часы МОСКОВСКОГО времени
 *  (фиксированный UTC+3, без tzdata). Отсутствие поля = показ 24/7 внутри
 *  окна startsAt/endsAt. */
export interface PromoSchedule {
  /** ISO-нумерация: 1=Пн … 7=Вс. Непустой, без дублей. */
  daysOfWeek: number[];
  /** 0..23, включительно, часы МСК. */
  hourStart: number;
  /** 1..24, исключающая граница; 24 = до полуночи. */
  hourEnd: number;
}

/**
 * A promo as stored in the S3 pool (promos.json). Queue membership/order lives in
 * queue-<name>.json, not by position here; a promo carries its own targeting, show window
 * and cooldown. Each checker reads only the fields it owns.
 */
export interface Promo {
  id: string;
  name: string;
  /** Show window, ISO-8601 timestamps. */
  startsAt: string;
  endsAt: string;
  /** Dayparting поверх окна дат (см. PromoSchedule). Omitted = 24/7. */
  schedule?: PromoSchedule;
  targeting: PromoTargeting;
  /** Max times one user may see this promo. Omitted = unlimited (limit checker skipped). */
  maxImpressionsPerUser?: number;
  /** Minimum hours between two shows to the same user. 0 = no cooldown. */
  cooldownHours: number;
  /** Chain: id of the predecessor promo. When set, this promo is eligible only
   *  after the user has at least one recorded impression of that predecessor
   *  (см. ChainChecker). Omitted = no chaining. */
  afterPromoId?: string;
  /** Chain по КЛИКУ: id промо-предшественника. When set, this promo is eligible
   *  only after the user has at least one recorded CTA click on that predecessor
   *  (см. ChainChecker; читает promo_clicks). Оба chain-поля заданы → AND.
   *  Omitted = no click-chaining. */
  afterClickPromoId?: string;
  /** Display format for the renderer. */
  format: PromoFormat;
  /** Custom format only: picks the host-owned render function via the
   *  <PromoProvider customFormats> map (keyed by this variant). A renderable
   *  field: select-promo hands it to the client untouched (NOT in the handle.ts
   *  server-only strip list). Ignored by every other format. */
  variant?: string;
  /** User-facing headline. */
  title: string;
  description?: string;
  imageUrl?: string;
  /** Focal metadata for imageUrl. Missing means the renderer uses the centre. */
  imageFocalPoint?: ImageFocalPoint;
  /** CTA: deep link/route + optional label + optional pill position (tl/tr/bl/br;
   *  default "br" on the storefront). */
  action?: { href: string; label?: string; position?: string };
  /** Overlays: whether the user can dismiss it (default true). */
  dismissible?: boolean;
  /** Banner/overlay background colour (CSS color). */
  backgroundColor?: string;
  /** Banner/overlay text colour (CSS color). */
  textColor?: string;
  /** Background image URL for popup/fullscreen overlays. */
  backgroundImage?: string;
  /** Linear gradient background (preferred over backgroundColor when set, ignored if backgroundImage). */
  backgroundGradient?: { from: string; to?: string; angle?: number };
  /** CTA button background color (CSS). Only used when `action` is set. */
  ctaColor?: string;
  /** CTA button text color (CSS). */
  ctaTextColor?: string;
  /** Text alignment inside overlay/inline body. Default 'left'. */
  textAlign?: 'left' | 'center' | 'right';
  /** Popup layout variant: 'classic' = title+desc stacked, 'split' = image-left/text-right. */
  popupVariant?: 'classic' | 'split';
  /** Optional bullet list rendered below description (max 6 × 80 chars). */
  bullets?: string[];
  /** DivKit format: URL to JSON-tree in S3 (rendered via @divkitframework/divkit). */
  divkitUrl?: string;
  /** Tooltip format only: id of the canonical host anchor element to point at
   *  (host marks it data-promo-anchor="<id>"). Required when format===='tooltip'. */
  anchor?: string;
  /** Multistep format only: wizard steps (2..6, title ≤ 80 / body ≤ 240 — the
   *  cabinet enforces the bounds). Rendered by @zebrooo/promo-renderer's
   *  MultistepPromo. A renderable field: select-promo hands it to the client
   *  untouched (NOT in the handle.ts server-only strip list).
   *  `imageUrl` (optional, http(s) URL ≤ 1024, png/jpg/webp/gif) — per-step
   *  picture/gif shown in the wizard's stage zone; takes priority over the
   *  host multistepStage slot (@zebrooo/promo-renderer 0.12.0). */
  steps?: { title: string; body: string; imageUrl?: string }[];
  /** Multistep format only: how the wizard presents itself — 'modal' (default,
   *  centered dialog) or 'fullscreen' (full-viewport takeover; renderer's
   *  zr-multistep--fullscreen, @zebrooo/promo-renderer 0.11.0). A renderable
   *  field: handed to the client untouched (NOT in the handle.ts strip list). */
  presentation?: 'modal' | 'fullscreen';
  /** Page sections this promo may show in (e.g. ['avto','realty']). Omitted = any section. */
  sections?: string[];
  /** Page categories this promo may show in. Omitted = any category. */
  categories?: string[];
  /** Audience gate: 'all'/omitted = everyone; 'authenticated' = logged-in users only; 'anonymous' = guests only. */
  audience?: 'all' | 'authenticated' | 'anonymous';
  /** Restrict to sellers (has active listings) or buyers (none). Omitted = either. */
  sellerStatus?: 'seller' | 'buyer';
  /** Таргетинг по стадии жизненного цикла собственных объявлений зрителя
   *  (LifecycleChecker). Server-only: клиенту не отдаётся. Omitted = гейта нет. */
  lifecycle?: PromoLifecycle;
  /** Device gate: 'desktop'/'touch' restricts to that device; 'both'/omitted = any.
   *  Enforced by the DeviceChecker against the request's `device`. */
  deviceTarget?: 'desktop' | 'touch' | 'both';
  /** Анти-таргетинг: true = скрыть промо от пользователя, кликнувшего по его
   *  CTA (или достигшего конверсии) — ReactionChecker. Omitted/false = показ
   *  не зависит от кликов. Server-only: клиенту не отдаётся. */
  suppressAfterClick?: boolean;
  /** Классы источника захода, при которых промо можно показывать (SourceChecker).
   *  Подмножество 4 классов; нет/пусто = любой источник (чекер скипается). */
  entrySources?: EntrySource[];
  /** Лид-режим: CTA не ведёт по ссылке, а отправляет рекламодателю телефон
   *  пользователя (сайт, /api/fp/o/lead). Поле РЕНДЕРАБЕЛЬНОЕ — уезжает
   *  клиенту вместе с креативом, поэтому в Omit'е Advertisement его нет.
   *  Внутри bff даёт один эффект: ReactionChecker гасит такое промо тому, кто
   *  уже отдал телефон (строка promo_clicks с kind='lead'). */
  leadCapture?: boolean;
}
