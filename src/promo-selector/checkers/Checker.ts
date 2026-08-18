import type { EntrySource, GeoSegment, Promo, PromoEnvSignal, SubscriptionLevel } from '../types';

/** Stable identity source, independent from current login state. */
export type IdentityKind = 'account' | 'anonymous';

/** Сигналы профиля визита, свёрнутые сайтом из кук (спека targeting-visit-profile §4). */
export interface VisitContext {
  source?: EntrySource;
  firstSeenDaysAgo?: number;
  visitDays?: number;
}

/** Per-promo evaluation context (identity + clock + the candidate promo). */
export interface CheckContext {
  promo: Promo;
  userId: string;
  /** Current login state. This affects audience eligibility only. */
  isAuthorized: boolean;
  /** Stable identity source; VisitorChecker выбирает по нему сигнал возраста. */
  identityKind?: IdentityKind;
  /** Профиль визита из params.visit; undefined = сайт сигнал не прислал. */
  visit?: VisitContext;
  now: Date;
  /** Page section the user is browsing (overlay only; undefined elsewhere). */
  section?: string;
  /** Page category the user is browsing. */
  category?: string;
  /** Requesting device; gates promos by deviceTarget. Undefined = no device filter. */
  device?: 'desktop' | 'touch' | 'app';
  /** Env-сигнал (ОС/среда/класс устройства), вычисленный сайтом. Undefined = сигнала нет:
   *  промо с env-правилами тогда фейлится (fail-closed в EnvChecker), без правил — не затронуто. */
  env?: PromoEnvSignal;
  /** Viewer's IP-geo segment, resolved by the storefront (never a raw IP). Undefined = не определилось:
   *  промо с гео-правилами тогда фейлится (fail-closed в GeoChecker), без правил — не затронуто. */
  geoSegment?: GeoSegment;
  /** Viewer's IP-geo city slug (та же номенклатура, что profiles.city). Undefined = город не определился. */
  geoCity?: string;
  /**
   * Acceptable creative formats for the requesting surface (e.g. ['topline'] for
   * the top banner, ['popup','fullscreen','inline','divkit'] for the overlay).
   * Lets one per-catalog queue hold mixed formats while each surface pulls only
   * the format(s) it can render. Undefined/empty = no format filter (back-compat:
   * surface separation stayed at the queue level).
   */
  formats?: string[];
  /** Search rows preloaded once for the whole selection walk. */
  searchHistory?: SearchHistoryEntry[];
  /** Поведенческий сигнал (интересы + телефоны), преднагруженный model handler'ом.
   *  undefined = сигнал не загружали или не смогли → interest/hot-buyer fail closed. */
  behavior?: BehaviorSignal;
  /** Карточек объявлений, открытых зрителем за текущий визит (из params сайта).
   *  undefined = неизвестно → engagement-промо fail closed. */
  sessionViews?: number;
  /** Покупки пакетов, преднагруженные на максимальное lookbackDays среди
   *  промо в очереди. Каждый чекер сам фильтрует по своему окну. */
  purchases?: PurchaseEntry[];
  /** Текущий остаток кошелька, kopecks. undefined = нет счёта/не загружали. */
  walletBalanceKopecks?: number;
  /** True only when the balance fetch itself failed (outage) — distinct from a genuinely absent wallet account, which is a legitimate 0. */
  walletBalanceUnavailable?: boolean;
  /** Net wallet movement per requested window. Key = the rule's `movementLookbackDays` (undefined key = all-time). */
  walletMovementByWindow?: Map<number | undefined, number>;
}

export interface SearchHistoryEntry {
  query: string;
  section: string;
  createdAt: string;
}

/** Агрегаты поведения зрителя из RPC promo_viewer_behavior (только агрегаты,
 *  сырые события не покидают Postgres abkhaz-auto). */
export interface BehaviorSignal {
  /** Категории, чьи объявления зритель открывал за 14 дней, свежие первыми. */
  interests: { category: string; lastViewedAt: string }[];
  /** Сколько РАЗНЫХ объявлений с открытым телефоном за 7 дней. */
  phoneViews7d: number;
}

export interface PurchaseEntry {
  pack: 'bump' | 'premium' | 'vip';
  /** Всегда положительное число (модуль списания), kopecks. */
  amountKopecks: number;
  createdAt: string;
}

/** All known supplier ids. */
export type SupplierId = 'userData' | 'listingStats';

/** Aggregated per-user data the userData supplier provides. */
export interface UserData {
  /** Full years; undefined when the user has no birthdate. */
  age?: number;
  /** Полных дней от profiles.created_at; undefined для анонима / без данных. */
  accountAgeDays?: number;
  region: string;
  subscriptionLevel: SubscriptionLevel;
  impressionCounts: Record<string, number>;
  lastShownAt: Record<string, string>;
  /** promoId -> суммарные клики этого пользователя (cta + conversion).
   *  Fail-soft: сбой чтения promo_clicks даёт {} (см. suppliers.loadUserData). */
  clickCounts: Record<string, number>;
}

import type { ListingStats } from '../../services/listing-service';
export type { ListingStats };

interface SupplierTypeMap {
  userData: UserData;
  listingStats: ListingStats;
}

/** Typed bag of the data for exactly the supplier ids a checker declared. */
export type SuppliersData<SID extends SupplierId> = { [K in SID]: SupplierTypeMap[K] };

/** Minimal logger shape; Fastify's logger satisfies it, tests pass nothing. */
export interface Logger {
  debug?(obj: unknown, msg?: string): void;
  error?(obj: unknown, msg?: string): void;
}

export abstract class Checker<SID extends SupplierId = never> {
  abstract readonly name: string;
  readonly requiredSupplierIDs: readonly SID[] = [] as readonly SID[];

  /** What must hold for this checker to pass (for logs). */
  abstract expect(): string;

  /** Self-skip: false = run; a string = skip with that reason (counts as eligible). */
  shouldSkip(_ctx: CheckContext): false | string {
    return false;
  }

  /** Core predicate; sees only its declared suppliers' data. Public for direct testing. */
  abstract check(ctx: CheckContext, data: SuppliersData<SID>): boolean | Promise<boolean>;

  /** Lifecycle: log expect → shouldSkip → check → log result. Fails closed on throw. */
  async run(ctx: CheckContext, data: SuppliersData<SID>, logger?: Logger): Promise<boolean> {
    logger?.debug?.({ checker: this.name, expect: this.expect() }, 'checker:expect');
    const reason = this.shouldSkip(ctx);
    if (reason) {
      logger?.debug?.({ checker: this.name, reason }, 'checker:skipped');
      return true;
    }
    try {
      const ok = await this.check(ctx, data);
      logger?.debug?.({ checker: this.name, ok }, ok ? 'checker:pass' : 'checker:mismatch');
      return ok;
    } catch (err) {
      logger?.error?.({ checker: this.name, err }, 'checker:error');
      return false;
    }
  }
}
