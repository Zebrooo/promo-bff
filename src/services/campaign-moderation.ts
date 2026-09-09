/**
 * Модерация рекламных кампаний рекламодателей.
 *
 * Кампанию создаёт витрина (abkhaz-auto, ЛК «Реклама») прямо в своей
 * Supabase; BFF её только читает для аукциона. Здесь — прослойка «сначала
 * подтверди»: поллер раз в N секунд смотрит ad_campaigns, каждую НОВУЮ
 * кампанию заводит в состоянии pending (S3, см. campaign-moderation-store.ts)
 * и шлёт админам уведомление; аукцион отдаёт только approved-кампании
 * (filterApproved); решение принимает админ в кабинете (decide).
 *
 * Инварианты:
 *   • Первый опрос без файла состояния — bootstrap: всё, что уже есть,
 *     считается одобренным. Включение фичи не гасит работающую рекламу.
 *   • Пока состояние ни разу не прочитано (S3 недоступна на старте) или
 *     bootstrap ещё не прошёл — filterApproved НЕ фильтрует (fail-open):
 *     ошибка инфраструктуры не должна обнулять выдачу рекламы. Прочитанное
 *     состояние кэшируется, и при сбое чтения используется последнее.
 *   • В БД витрины BFF пишет минимально и best-effort: approve → status
 *     'active', если кампания стояла в 'pending'; reject → status 'paused'.
 *     Отказ PostgREST (неизвестный статус) не ломает решение — оно уже в S3,
 *     а аукцион смотрит именно туда.
 */
import type { BalanceService } from './balance-service';
import type { CampaignCandidate } from './campaign-service';
import type { CampaignReviewRow, CampaignReviewService } from './campaign-review-service';
import type { ModerationDecision, ModerationEntry, ModerationState, ModerationStore } from './campaign-moderation-store';
import type { AdminNotification, AdminNotifier } from './admin-notifier';

export interface ModerationLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface CampaignModerationDeps {
  review: CampaignReviewService;
  store: ModerationStore;
  balances: BalanceService;
  notifier: AdminNotifier;
  logger?: ModerationLogger;
  /** Публичный URL кабинета для ссылки в уведомлении; пусто = без ссылки. */
  cabinetUrl?: string;
  now?: () => Date;
}

/** Кампания в выдаче для кабинета: строка БД + решение + баланс рекламодателя. */
export interface ModeratedCampaign extends CampaignReviewRow {
  moderation: ModerationEntry;
  /** Копейки на кошельке рекламодателя; null = кошелька нет/не прочитался. */
  balanceKopecks: number | null;
  /** Баланс известен и ≤ 0 — кампании нечем откручиваться. */
  zeroBalance: boolean;
}

export interface ModerationListing {
  pending: ModeratedCampaign[];
  /** Последние решения (новые сверху), чтобы видеть историю. */
  recent: ModeratedCampaign[];
  channels: AdminNotifier['channels'];
}

export type DecideResult =
  | { ok: true; campaign: ModeratedCampaign }
  | { ok: false; error: 'not_found' | 'not_configured' };

export interface CampaignModeration {
  configured: boolean;
  /** Один проход поллера. Возвращает id новых кампаний, заведённых в pending. */
  poll(): Promise<{ newPending: number[] }>;
  list(): Promise<ModerationListing>;
  decide(campaignId: number, decision: Exclude<ModerationDecision, 'pending'>, actor: string, reason?: string): Promise<DecideResult>;
  /** Кандидаты аукциона → только одобренные (см. инварианты в шапке). */
  filterApproved<T extends Pick<CampaignCandidate, 'id'>>(candidates: T[]): Promise<T[]>;
  start(intervalMs: number): void;
  stop(): void;
}

/** Статусы, в которых кампания «хочет показываться» и потому подлежит
 *  модерации. 'pending' — на случай, если витрина когда-нибудь начнёт
 *  создавать кампании сразу «на модерацию» (тогда approve переведёт её в
 *  active). Черновики/архив не трогаем. */
export const MODERATED_STATUSES = ['active', 'pending'] as const;
const RECENT_LIMIT = 30;
const STATE_CACHE_TTL_MS = 15_000;
/** Bootstrap и опрос должны видеть ВСЕ живые кампании: кампания за пределами
 *  выборки при bootstrap потом всплыла бы как «новая» и встала на модерацию. */
const POLL_LIMIT = 5000;

export function formatRub(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

export function buildNewCampaignNotification(
  c: CampaignReviewRow,
  balanceKopecks: number | null,
  cabinetUrl: string | undefined,
  resubmitted = false,
): AdminNotification {
  const parts: string[] = [];
  parts.push(c.name ? `«${c.name}»` : 'Без названия');
  parts.push(`CPM ${formatRub(c.cpmKopecks)}`);
  if (c.totalBudgetKopecks !== null) parts.push(`бюджет ${formatRub(c.totalBudgetKopecks)}`);
  else if (c.dailyBudgetKopecks !== null) parts.push(`${formatRub(c.dailyBudgetKopecks)}/день`);
  let body = parts.join(' · ');
  if (balanceKopecks !== null && balanceKopecks <= 0) body += '\n⚠️ Баланс рекламодателя 0 ₽ — откручиваться нечем';
  body += '\nЖдёт подтверждения в кабинете.';
  return {
    title: resubmitted ? `Кампания №${c.id} отправлена повторно` : `Новая рекламная кампания №${c.id}`,
    body,
    ...(cabinetUrl ? { url: `${cabinetUrl}/cabinet/campaigns` } : {}),
    tag: `campaign-${c.id}`,
  };
}

export function createCampaignModeration(deps: CampaignModerationDeps): CampaignModeration {
  const { review, store, balances, notifier, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();

  // Кэш состояния для горячего пути аукциона (filterApproved). Обновляется
  // каждым poll/decide и по TTL.
  let cached: { state: ModerationState; at: number } | null = null;
  const remember = (state: ModerationState) => { cached = { state, at: Date.now() }; };

  // Один процесс, но poll() и decide() — read-modify-write одного объекта:
  // сериализуем, чтобы поллер не затёр только что принятое решение.
  let chain: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  async function readState(): Promise<ModerationState> {
    const state = await store.read();
    remember(state);
    return state;
  }

  async function writeState(state: ModerationState): Promise<void> {
    await store.write(state);
    remember(state);
  }

  async function balancesFor(rows: CampaignReviewRow[]): Promise<Map<string, number>> {
    const ids = [...new Set(rows.map((r) => r.advertiserId).filter(Boolean))];
    if (ids.length === 0) return new Map();
    try {
      return await balances.getBalances(ids);
    } catch (err) {
      logger?.warn({ err }, 'campaign-moderation: balance service unavailable, balances unknown');
      return new Map();
    }
  }

  function decorate(row: CampaignReviewRow, entry: ModerationEntry, bal: Map<string, number>): ModeratedCampaign {
    const balanceKopecks = bal.has(row.advertiserId) ? (bal.get(row.advertiserId) as number) : null;
    return { ...row, moderation: entry, balanceKopecks, zeroBalance: balanceKopecks !== null && balanceKopecks <= 0 };
  }

  async function poll(): Promise<{ newPending: number[] }> {
    if (!review.configured) return { newPending: [] };
    return withLock(async () => {
      const rows = await review.listCampaigns({ statuses: [...MODERATED_STATUSES], limit: POLL_LIMIT });
      const state = await readState();
      const at = iso();

      if (state.bootstrappedAt === null) {
        for (const r of rows) {
          state.campaigns[String(r.id)] ??= { decision: 'approved', seenAt: at, decidedAt: at, decidedBy: 'bootstrap', reason: 'запущена до включения модерации' };
        }
        state.bootstrappedAt = at;
        await writeState(state);
        logger?.info({ campaigns: rows.length }, 'campaign-moderation: bootstrapped, existing campaigns approved');
        return { newPending: [] };
      }

      const fresh = rows.filter((r) => state.campaigns[String(r.id)] === undefined);
      // Отклонённая кампания, которую рекламодатель включил заново (мы её
      // ставили в paused, а она снова active) — повторная модерация, иначе
      // она молча висела бы заблокированной навсегда. Если PATCH в paused
      // тогда не прошёл, статус active ничего не значит — не трогаем.
      const resubmitted = rows.filter((r) => {
        const e = state.campaigns[String(r.id)];
        return e?.decision === 'rejected' && e.dbStatusAfterDecision === 'paused' && r.status === 'active';
      });
      if (fresh.length === 0 && resubmitted.length === 0) return { newPending: [] };

      for (const r of fresh) state.campaigns[String(r.id)] = { decision: 'pending', seenAt: at };
      for (const r of resubmitted) {
        const prev = state.campaigns[String(r.id)]!;
        state.campaigns[String(r.id)] = { decision: 'pending', seenAt: prev.seenAt, resubmittedAt: at };
      }
      await writeState(state);
      logger?.info(
        { ids: fresh.map((r) => r.id), resubmitted: resubmitted.map((r) => r.id) },
        'campaign-moderation: campaigns pending approval',
      );

      const toNotify = [...fresh, ...resubmitted];
      const resubmittedIds = new Set(resubmitted.map((r) => r.id));
      const bal = await balancesFor(toNotify);
      for (const r of toNotify) {
        const balance = bal.has(r.advertiserId) ? (bal.get(r.advertiserId) as number) : null;
        try {
          const outcome = await notifier.notify(
            buildNewCampaignNotification(r, balance, deps.cabinetUrl, resubmittedIds.has(r.id)),
          );
          if (outcome.delivered > 0) {
            state.campaigns[String(r.id)] = { ...state.campaigns[String(r.id)]!, notifiedAt: iso() };
          }
        } catch (err) {
          logger?.error({ err, campaignId: r.id }, 'campaign-moderation: notify failed');
        }
      }
      await writeState(state);
      return { newPending: toNotify.map((r) => r.id) };
    });
  }

  async function list(): Promise<ModerationListing> {
    const state = await readState();
    const entries = Object.entries(state.campaigns);
    const pendingIds = entries.filter(([, e]) => e.decision === 'pending').map(([id]) => Number(id));
    const recentIds = entries
      .filter(([, e]) => e.decision !== 'pending' && e.decidedBy !== 'bootstrap')
      .sort(([, a], [, b]) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? ''))
      .slice(0, RECENT_LIMIT)
      .map(([id]) => Number(id));
    const ids = [...new Set([...pendingIds, ...recentIds])];
    const rows = ids.length > 0 ? await review.listCampaigns({ ids, limit: ids.length }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const bal = await balancesFor(rows);
    const build = (id: number): ModeratedCampaign | null => {
      const row = byId.get(id);
      const entry = state.campaigns[String(id)];
      return row && entry ? decorate(row, entry, bal) : null;
    };
    return {
      // Новые сверху — админ смотрит на самое свежее.
      pending: pendingIds.sort((a, b) => b - a).map(build).filter((c): c is ModeratedCampaign => c !== null),
      recent: recentIds.map(build).filter((c): c is ModeratedCampaign => c !== null),
      channels: notifier.channels,
    };
  }

  async function decide(campaignId: number, decision: Exclude<ModerationDecision, 'pending'>, actor: string, reason?: string): Promise<DecideResult> {
    if (!review.configured) return { ok: false, error: 'not_configured' };
    return withLock(async () => {
      const [row] = await review.listCampaigns({ ids: [campaignId], limit: 1 });
      if (!row) return { ok: false, error: 'not_found' };
      const state = await readState();
      const at = iso();
      const prev = state.campaigns[String(campaignId)];
      const entry: ModerationEntry = {
        decision,
        seenAt: prev?.seenAt ?? at,
        decidedAt: at,
        decidedBy: actor,
        ...(reason && reason.trim() ? { reason: reason.trim() } : {}),
        ...(prev?.notifiedAt ? { notifiedAt: prev.notifiedAt } : {}),
      };
      state.campaigns[String(campaignId)] = entry;
      await writeState(state);

      // Статус в БД витрины — best-effort, см. шапку.
      const target = decision === 'approved' ? (row.status === 'pending' ? 'active' : null) : 'paused';
      if (target !== null && row.status !== target) {
        try {
          const res = await review.setStatus(campaignId, target);
          if (!res.ok) logger?.warn({ campaignId, target, error: res.error }, 'campaign-moderation: status update rejected by storefront DB');
          else {
            row.status = target;
            entry.dbStatusAfterDecision = target;
            state.campaigns[String(campaignId)] = entry;
            await writeState(state);
          }
        } catch (err) {
          logger?.warn({ err, campaignId, target }, 'campaign-moderation: status update failed');
        }
      } else if (target !== null) {
        entry.dbStatusAfterDecision = target;
        state.campaigns[String(campaignId)] = entry;
        await writeState(state);
      }
      logger?.info({ campaignId, decision, actor }, 'campaign-moderation: decision recorded');
      const bal = await balancesFor([row]);
      return { ok: true, campaign: decorate(row, entry, bal) };
    });
  }

  // Горячий путь аукциона: один read на TTL, параллельные вызовы ждут один и
  // тот же GET, а после сбоя S3 повторная попытка — не раньше, чем через TTL
  // (иначе каждый /auction при лежащей S3 ждал бы свой таймаут).
  let readInFlight: Promise<ModerationState | null> | null = null;
  let lastFailureAt = 0;
  function stateForFilter(): Promise<ModerationState | null> {
    const at = Date.now();
    if (cached && at - cached.at < STATE_CACHE_TTL_MS) return Promise.resolve(cached.state);
    if (at - lastFailureAt < STATE_CACHE_TTL_MS) return Promise.resolve(cached?.state ?? null);
    if (readInFlight) return readInFlight;
    readInFlight = readState()
      .then((state): ModerationState | null => state)
      .catch((err) => {
        lastFailureAt = Date.now();
        logger?.error({ err }, 'campaign-moderation: cannot read state, using last known');
        return cached?.state ?? null;
      })
      .finally(() => { readInFlight = null; });
    return readInFlight;
  }

  async function filterApproved<T extends Pick<CampaignCandidate, 'id'>>(candidates: T[]): Promise<T[]> {
    if (!review.configured || candidates.length === 0) return candidates;
    const state = await stateForFilter();
    if (state === null || state.bootstrappedAt === null) return candidates; // fail-open, см. шапку
    return candidates.filter((c) => state.campaigns[String(c.id)]?.decision === 'approved');
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  function tick(): void {
    if (inFlight) return;
    inFlight = true;
    poll()
      .catch((err) => logger?.error({ err }, 'campaign-moderation: poll failed'))
      .finally(() => { inFlight = false; });
  }

  return {
    configured: review.configured,
    poll,
    list,
    decide,
    filterApproved,
    start(intervalMs) {
      if (timer !== null || !review.configured) return;
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        logger?.warn({ intervalMs }, 'campaign-moderation: poller disabled (CAMPAIGN_MODERATION_POLL_MS is 0 or invalid)');
        return;
      }
      tick();
      timer = setInterval(tick, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
  };
}
