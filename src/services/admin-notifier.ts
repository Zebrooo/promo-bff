/**
 * Уведомления админам промо-кабинета («пуши»). Два канала, оба опциональны и
 * включаются конфигом:
 *
 *   • Web Push — подписки браузеров админов кабинет складывает в S3
 *     (push-subscriptions.json, тот же бакет/префикс, что promos.json);
 *     BFF подписывает VAPID-ключами и шлёт на endpoint'ы push-сервисов.
 *   • Telegram — sendMessage в перечисленные чаты от имени бота.
 *
 * Отправка best-effort: сбой одного адресата не мешает остальным, наружу
 * уходит только счётчик доставок. Ничего чувствительного в текстах нет
 * (id кампании, название, суммы) — их видит и так любой админ кабинета.
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config, type AdminNotifyConfig } from '../config';
import { getS3Client, isNoSuchKey, pushSubscriptionsKey } from './s3-client';
import { sendWebPush, type VapidKeys, type WebPushSubscription } from './web-push';

export interface AdminNotification {
  title: string;
  body: string;
  /** Куда ведёт клик по уведомлению (страница «Кампании» в кабинете). */
  url?: string;
  /** Группировка одинаковых уведомлений в браузере. */
  tag?: string;
}

export interface NotifyOutcome {
  attempted: number;
  delivered: number;
  failed: number;
}

export interface AdminNotifier {
  /** Сконфигурированные каналы — кабинет показывает подсказку, если пусто. */
  channels: ('webPush' | 'telegram')[];
  notify(n: AdminNotification): Promise<NotifyOutcome>;
}

/** Запись подписки, как её пишет кабинет (см. promo-cabinet lib/push-subscriptions.ts). */
export interface PushSubscriptionRecord extends WebPushSubscription {
  createdAt?: string;
  userAgent?: string;
}

export interface NotifierLogger {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

export interface AdminNotifierDeps {
  webPush?: {
    keys: VapidKeys;
    loadSubscriptions(): Promise<PushSubscriptionRecord[]>;
    /** Убрать подписки, которые push-сервис объявил мёртвыми (404/410) —
     *  иначе каждая рассылка вечно шифрует и шлёт в пустоту. */
    removeSubscriptions?(endpoints: string[]): Promise<void>;
  } | null;
  telegram?: { botToken: string; chatIds: string[] } | null;
  fetchImpl?: typeof fetch;
  logger?: NotifierLogger;
}

/** Подписки из S3. Формат файла: { version: 1, subscriptions: [...] }; кривые
 *  записи пропускаются, отсутствующий файл = нет подписчиков. */
export async function readPushSubscriptionsFromS3(): Promise<PushSubscriptionRecord[]> {
  let text: string;
  try {
    const res = await getS3Client().send(
      new GetObjectCommand({ Bucket: config.s3.bucket, Key: pushSubscriptionsKey() }),
    );
    if (!res.Body) return [];
    text = await res.Body.transformToString();
  } catch (err) {
    if (isNoSuchKey(err)) return [];
    throw err;
  }
  return parsePushSubscriptions(JSON.parse(text));
}

/** Удалить подписки по endpoint из S3-файла кабинета. Read-modify-write того
 *  же объекта, что пишет кабинет; подписок единицы, а мёртвые endpoint'ы
 *  никому не нужны, так что last-write-wins здесь безопасен. */
export async function removePushSubscriptionsFromS3(endpoints: string[]): Promise<void> {
  if (endpoints.length === 0) return;
  const current = await readPushSubscriptionsFromS3();
  const gone = new Set(endpoints);
  const next = current.filter((s) => !gone.has(s.endpoint));
  if (next.length === current.length) return;
  await getS3Client().send(
    new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: pushSubscriptionsKey(),
      Body: JSON.stringify({ version: 1, subscriptions: next }, null, 2),
      ContentType: 'application/json',
    }),
  );
}

export function parsePushSubscriptions(raw: unknown): PushSubscriptionRecord[] {
  const list = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { subscriptions?: unknown }).subscriptions)
      ? ((raw as { subscriptions: unknown[] }).subscriptions)
      : [];
  const out: PushSubscriptionRecord[] = [];
  for (const item of list) {
    if (typeof item !== 'object' || item === null) continue;
    const r = item as Record<string, unknown>;
    const keys = r.keys as Record<string, unknown> | undefined;
    if (typeof r.endpoint !== 'string' || !/^https:\/\//.test(r.endpoint)) continue;
    if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') continue;
    out.push({
      endpoint: r.endpoint,
      keys: { p256dh: keys.p256dh, auth: keys.auth },
      ...(typeof r.createdAt === 'string' ? { createdAt: r.createdAt } : {}),
      ...(typeof r.userAgent === 'string' ? { userAgent: r.userAgent } : {}),
    });
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function createAdminNotifier(deps: AdminNotifierDeps): AdminNotifier {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const logger = deps.logger;
  const channels: AdminNotifier['channels'] = [];
  if (deps.webPush) channels.push('webPush');
  if (deps.telegram && deps.telegram.botToken && deps.telegram.chatIds.length > 0) channels.push('telegram');

  async function sendPushes(n: AdminNotification): Promise<NotifyOutcome> {
    const wp = deps.webPush;
    if (!wp) return { attempted: 0, delivered: 0, failed: 0 };
    let subs: PushSubscriptionRecord[];
    try {
      subs = await wp.loadSubscriptions();
    } catch (err) {
      logger?.error({ err }, 'admin-notifier: cannot read push subscriptions');
      return { attempted: 0, delivered: 0, failed: 0 };
    }
    const payload = JSON.stringify({ title: n.title, body: n.body, url: n.url ?? null, tag: n.tag ?? null });
    const results = await Promise.allSettled(
      subs.map((sub) => sendWebPush(sub, payload, wp.keys, { fetchImpl })),
    );
    let delivered = 0;
    let failed = 0;
    const gone: string[] = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled' && r.value.ok) {
        delivered += 1;
        return;
      }
      failed += 1;
      const endpointHost = (() => { try { return new URL(subs[i]!.endpoint).host; } catch { return '?'; } })();
      if (r.status === 'fulfilled') {
        if (r.value.gone) gone.push(subs[i]!.endpoint);
        logger?.warn({ endpointHost, status: r.value.status, gone: r.value.gone }, 'admin-notifier: web push rejected');
      } else {
        logger?.warn({ endpointHost, err: r.reason }, 'admin-notifier: web push failed');
      }
    });
    if (gone.length > 0 && wp.removeSubscriptions) {
      try {
        await wp.removeSubscriptions(gone);
        logger?.info({ removed: gone.length }, 'admin-notifier: pruned dead push subscriptions');
      } catch (err) {
        logger?.warn({ err }, 'admin-notifier: cannot prune dead push subscriptions');
      }
    }
    return { attempted: subs.length, delivered, failed };
  }

  async function sendTelegram(n: AdminNotification): Promise<NotifyOutcome> {
    const tg = deps.telegram;
    if (!tg || !tg.botToken || tg.chatIds.length === 0) return { attempted: 0, delivered: 0, failed: 0 };
    const text =
      `<b>${escapeHtml(n.title)}</b>\n${escapeHtml(n.body)}` +
      (n.url ? `\n<a href="${escapeHtml(n.url)}">Открыть в кабинете</a>` : '');
    const results = await Promise.allSettled(
      tg.chatIds.map(async (chatId) => {
        const res = await fetchImpl(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
          signal: AbortSignal.timeout(8000),
        });
        if (!res.ok) throw new Error(`telegram sendMessage HTTP ${res.status}`);
      }),
    );
    let delivered = 0;
    let failed = 0;
    for (const r of results) {
      if (r.status === 'fulfilled') delivered += 1;
      else {
        failed += 1;
        // Токен бота в err не попадает: URL мы в сообщение ошибки не кладём.
        logger?.warn({ err: r.reason }, 'admin-notifier: telegram send failed');
      }
    }
    return { attempted: tg.chatIds.length, delivered, failed };
  }

  return {
    channels,
    async notify(n) {
      const [push, tg] = await Promise.all([sendPushes(n), sendTelegram(n)]);
      const out = {
        attempted: push.attempted + tg.attempted,
        delivered: push.delivered + tg.delivered,
        failed: push.failed + tg.failed,
      };
      logger?.info({ title: n.title, ...out, channels }, 'admin-notifier: notification sent');
      return out;
    },
  };
}

/** Продовая сборка из env: канал появляется только при полном конфиге. */
export function createAdminNotifierFromConfig(
  cfg: AdminNotifyConfig = config.adminNotify,
  logger?: NotifierLogger,
): AdminNotifier {
  const { webPush, telegram } = cfg;
  return createAdminNotifier({
    webPush: webPush.vapidPublicKey && webPush.vapidPrivateKey
      ? {
          keys: { publicKey: webPush.vapidPublicKey, privateKey: webPush.vapidPrivateKey, subject: webPush.subject },
          loadSubscriptions: readPushSubscriptionsFromS3,
          removeSubscriptions: removePushSubscriptionsFromS3,
        }
      : null,
    telegram: telegram.botToken && telegram.chatIds.length > 0 ? telegram : null,
    logger,
  });
}
