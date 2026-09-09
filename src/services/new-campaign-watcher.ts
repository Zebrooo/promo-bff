/**
 * Пуши админам о новых рекламных кампаниях рекламодателей.
 *
 * Кампанию создаёт витрина (abkhaz-auto, ЛК «Реклама») прямо в своей
 * Supabase; BFF её только читает. Поллер раз в N секунд смотрит ad_campaigns
 * и о каждой ещё не виденной кампании шлёт админам уведомление (Web Push /
 * Telegram, см. admin-notifier.ts). На аукцион и выдачу не влияет — это
 * только оповещение.
 *
 * «Уже видели» хранится в S3 (seen-campaigns.json, рядом с promos.json):
 * первый запуск без файла — bootstrap, всё существующее помечается виденным
 * без уведомлений, чтобы включение фичи не выслало сотню пушей разом.
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';
import { getS3Client, isNoSuchKey, seenCampaignsKey } from './s3-client';
import type { CampaignReviewRow, CampaignReviewService } from './campaign-review-service';
import type { AdminNotification, AdminNotifier } from './admin-notifier';

export interface SeenEntry {
  /** Когда BFF впервые увидел кампанию. */
  seenAt: string;
  /** Когда админам ушло уведомление (нет = не доставлено / bootstrap). */
  notifiedAt?: string;
  /** Помечена при bootstrap (существовала до включения фичи) — в списке
   *  «последние новые» не показывается. */
  bootstrap?: true;
}

export interface SeenState {
  version: 1;
  /** null = файла ещё не было → следующий опрос делает bootstrap. */
  bootstrappedAt: string | null;
  /** campaignId (строкой) → запись. */
  campaigns: Record<string, SeenEntry>;
}

export interface SeenCampaignsStore {
  read(): Promise<SeenState>;
  write(state: SeenState): Promise<void>;
}

export interface WatcherLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface NewCampaignWatcherDeps {
  review: CampaignReviewService;
  store: SeenCampaignsStore;
  notifier: AdminNotifier;
  logger?: WatcherLogger;
  /** Публичный URL кабинета для ссылки в уведомлении; пусто = без ссылки. */
  cabinetUrl?: string;
  now?: () => Date;
}

/** Кампания в выдаче для кабинета: строка БД + когда увидели/уведомили. */
export interface RecentCampaign extends CampaignReviewRow {
  seenAt: string;
  notifiedAt: string | null;
}

export interface RecentListing {
  campaigns: RecentCampaign[];
  channels: AdminNotifier['channels'];
}

export interface NewCampaignWatcher {
  configured: boolean;
  /** Один проход поллера. Возвращает id кампаний, о которых ушёл пуш. */
  poll(): Promise<{ notified: number[] }>;
  /** Последние новые кампании (новые сверху) для страницы кабинета. */
  recent(): Promise<RecentListing>;
  start(intervalMs: number): void;
  stop(): void;
}

/** Уведомляем о кампаниях, которые «хотят показываться»; черновики — нет. */
export const WATCHED_STATUSES = ['active', 'pending'] as const;
const RECENT_LIMIT = 30;
/** Bootstrap и опрос должны видеть ВСЕ живые кампании: кампания за пределами
 *  выборки при bootstrap потом всплыла бы как «новая». */
const POLL_LIMIT = 5000;

export function emptySeenState(): SeenState {
  return { version: 1, bootstrappedAt: null, campaigns: {} };
}

function normalize(raw: unknown): SeenState {
  if (typeof raw !== 'object' || raw === null) return emptySeenState();
  const r = raw as Record<string, unknown>;
  const campaigns: Record<string, SeenEntry> = {};
  const rawCampaigns = r.campaigns;
  if (typeof rawCampaigns === 'object' && rawCampaigns !== null) {
    for (const [id, entry] of Object.entries(rawCampaigns as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      campaigns[id] = {
        seenAt: typeof e.seenAt === 'string' ? e.seenAt : new Date(0).toISOString(),
        ...(typeof e.notifiedAt === 'string' ? { notifiedAt: e.notifiedAt } : {}),
        ...(e.bootstrap === true ? { bootstrap: true as const } : {}),
      };
    }
  }
  return { version: 1, bootstrappedAt: typeof r.bootstrappedAt === 'string' ? r.bootstrappedAt : null, campaigns };
}

export function createS3SeenCampaignsStore(): SeenCampaignsStore {
  return {
    async read() {
      try {
        const res = await getS3Client().send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: seenCampaignsKey() }));
        if (!res.Body) return emptySeenState();
        const text = await res.Body.transformToString();
        try {
          return normalize(JSON.parse(text));
        } catch {
          // Битый JSON (обрыв записи, ручная правка) — как отсутствующий файл:
          // следующий опрос сделает bootstrap заново. Иначе поллер падал бы
          // каждую минуту, пока кто-то не починит объект руками.
          console.warn('[new-campaign-watcher] seen-campaigns.json is not valid JSON — treating as missing');
          return emptySeenState();
        }
      } catch (err) {
        if (isNoSuchKey(err)) return emptySeenState();
        throw err;
      }
    },
    async write(state) {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: seenCampaignsKey(),
          Body: JSON.stringify(state, null, 2),
          ContentType: 'application/json',
        }),
      );
    },
  };
}

/** Тестовый стор в памяти (та же семантика «нет файла → пустое состояние»). */
export function createInMemorySeenCampaignsStore(initial?: SeenState): SeenCampaignsStore & { state: SeenState | null } {
  const box: { state: SeenState | null } = { state: initial ?? null };
  return {
    get state() { return box.state; },
    set state(v) { box.state = v; },
    async read() { return box.state ? normalize(JSON.parse(JSON.stringify(box.state))) : emptySeenState(); },
    async write(state) { box.state = JSON.parse(JSON.stringify(state)); },
  };
}

export function formatRub(kopecks: number): string {
  return `${(kopecks / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} ₽`;
}

export function buildNewCampaignNotification(c: CampaignReviewRow, cabinetUrl: string | undefined): AdminNotification {
  const parts: string[] = [];
  parts.push(c.name ? `«${c.name}»` : 'Без названия');
  parts.push(`CPM ${formatRub(c.cpmKopecks)}`);
  if (c.totalBudgetKopecks !== null) parts.push(`бюджет ${formatRub(c.totalBudgetKopecks)}`);
  else if (c.dailyBudgetKopecks !== null) parts.push(`${formatRub(c.dailyBudgetKopecks)}/день`);
  return {
    title: `Новая рекламная кампания №${c.id}`,
    body: parts.join(' · '),
    ...(cabinetUrl ? { url: `${cabinetUrl}/cabinet/campaigns` } : {}),
    tag: `campaign-${c.id}`,
  };
}

export function createNewCampaignWatcher(deps: NewCampaignWatcherDeps): NewCampaignWatcher {
  const { review, store, notifier, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();

  // poll() и recent() читают один объект; poll() его пишет. Сериализуем
  // опросы, чтобы два тика (медленная S3) не уведомили об одном дважды.
  let chain: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  let warnedNoChannels = false;

  async function poll(): Promise<{ notified: number[] }> {
    if (!review.configured) return { notified: [] };
    return withLock(async () => {
      // Дешёвый опрос: только id+status; полные строки — лишь для новых.
      const ids = await review.listCampaignIds({ statuses: [...WATCHED_STATUSES], limit: POLL_LIMIT });
      const state = await store.read();
      const at = iso();

      if (state.bootstrappedAt === null) {
        for (const r of ids) state.campaigns[String(r.id)] ??= { seenAt: at, bootstrap: true };
        state.bootstrappedAt = at;
        await store.write(state);
        logger?.info({ campaigns: ids.length }, 'new-campaign-watcher: bootstrapped, existing campaigns marked seen');
        return { notified: [] };
      }

      const freshIds = ids.filter((r) => state.campaigns[String(r.id)] === undefined).map((r) => r.id);
      if (freshIds.length === 0) return { notified: [] };

      // Нет ни одного канала — не «съедаем» кампании: как только оператор
      // задаст VAPID/Telegram, о них уйдут пуши. Предупреждаем один раз.
      if (notifier.channels.length === 0) {
        if (!warnedNoChannels) {
          warnedNoChannels = true;
          logger?.warn({ pending: freshIds.length }, 'new-campaign-watcher: new campaigns but no notification channel configured (WEB_PUSH_* / ADMIN_TELEGRAM_*)');
        }
        return { notified: [] };
      }

      const fresh = await review.listCampaigns({ ids: freshIds, limit: freshIds.length });
      // Сначала фиксируем «видели», потом шлём: упавшая отправка не должна
      // превращаться в пуш каждую минуту.
      for (const id of freshIds) state.campaigns[String(id)] = { seenAt: at };
      await store.write(state);
      logger?.info({ ids: freshIds }, 'new-campaign-watcher: new campaigns');

      const notified: number[] = [];
      let dirty = false;
      for (const r of fresh) {
        try {
          const outcome = await notifier.notify(buildNewCampaignNotification(r, deps.cabinetUrl));
          if (outcome.delivered > 0) {
            state.campaigns[String(r.id)] = { seenAt: at, notifiedAt: iso() };
            notified.push(r.id);
            dirty = true;
          } else if (outcome.attempted === 0) {
            // Никому даже не пытались отправить (нет подписчиков / не
            // прочитался список подписок) — вернём в «не видели», чтобы
            // повторить на следующем тике, когда подписчики появятся.
            delete state.campaigns[String(r.id)];
            dirty = true;
          }
        } catch (err) {
          logger?.error({ err, campaignId: r.id }, 'new-campaign-watcher: notify failed');
        }
      }
      if (dirty) await store.write(state);
      return { notified };
    });
  }

  async function recent(): Promise<RecentListing> {
    const state = await store.read();
    const ids = Object.entries(state.campaigns)
      .filter(([, e]) => !e.bootstrap)
      .sort(([a], [b]) => Number(b) - Number(a))
      .slice(0, RECENT_LIMIT)
      .map(([id]) => Number(id));
    const rows = ids.length > 0 ? await review.listCampaigns({ ids, limit: ids.length }) : [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const campaigns = ids.flatMap((id): RecentCampaign[] => {
      const row = byId.get(id);
      const entry = state.campaigns[String(id)];
      return row && entry ? [{ ...row, seenAt: entry.seenAt, notifiedAt: entry.notifiedAt ?? null }] : [];
    });
    return { campaigns, channels: notifier.channels };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlight = false;
  function tick(): void {
    if (inFlight) return;
    inFlight = true;
    poll()
      .catch((err) => logger?.error({ err }, 'new-campaign-watcher: poll failed'))
      .finally(() => { inFlight = false; });
  }

  return {
    configured: review.configured,
    poll,
    recent,
    start(intervalMs) {
      if (timer !== null || !review.configured) return;
      if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
        logger?.warn({ intervalMs }, 'new-campaign-watcher: poller disabled (NEW_CAMPAIGN_POLL_MS is 0 or invalid)');
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
