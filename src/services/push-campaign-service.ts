/**
 * Пуш-кампании: CRUD черновиков + отправка.
 *
 * Черновик живёт в S3 (push-campaign-store.ts); «Отправить» — один вызов
 * витрины (push-broadcast-client.ts), после которого кампания становится
 * `sent` и больше не редактируется/не отправляется (409 already_sent).
 *
 * Порядок при отправке — «сначала фиксируем, потом шлём», как у поллера
 * новых кампаний: статус `sent` пишется в S3 ДО вызова витрины. Если
 * рассылка упала, откатываем в черновик с lastSendError; если упал сам BFF
 * между записью и ответом витрины — кампания останется «отправленной» без
 * итога. Это осознанно: повторный пуш всем пользователям хуже, чем
 * пропавшая статистика. Все мутации сериализованы одной цепочкой промисов,
 * чтобы двойной клик «Отправить» не ушёл двумя рассылками.
 *
 * Таргетинг (первый этап): сохраняется, но на отбор получателей не влияет —
 * рассылка уходит всем пользователям с FCM-токенами (userIds не передаём).
 */
import { randomBytes } from 'node:crypto';
import type { PushCampaignStore } from './push-campaign-store';
import { PushBroadcastError, type PushBroadcastClient } from './push-broadcast-client';
import type { PushCampaign, PushCampaignInput } from './push-campaign-schema';

export interface PushCampaignServiceDeps {
  store: PushCampaignStore;
  broadcast: PushBroadcastClient;
  now?: () => Date;
  newId?: () => string;
  logger?: { info(obj: unknown, msg?: string): void; error(obj: unknown, msg?: string): void };
}

export type SaveResult =
  | { ok: true; campaign: PushCampaign; created: boolean }
  | { ok: false; error: 'not_found' | 'already_sent' };

export type SendResult =
  | { ok: true; campaign: PushCampaign }
  | { ok: false; error: 'not_found' | 'already_sent' | 'push_not_configured' | 'push_broadcast_failed'; reason?: string };

export interface PushCampaignService {
  /** false = витрина для рассылки не настроена; черновики при этом работают. */
  broadcastConfigured: boolean;
  list(): Promise<PushCampaign[]>;
  get(id: string): Promise<PushCampaign | null>;
  save(input: PushCampaignInput): Promise<SaveResult>;
  remove(id: string): Promise<{ ok: true } | { ok: false; error: 'not_found' }>;
  send(id: string): Promise<SendResult>;
}

/** Новее — выше: список кабинета читается сверху вниз. */
function byNewest(a: PushCampaign, b: PushCampaign): number {
  return b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt);
}

export function defaultPushCampaignId(): string {
  return `push-${randomBytes(6).toString('hex')}`;
}

/** Данные пуша, которые уедут в витрину. data — только строки (FCM). */
export function toBroadcastRequest(c: PushCampaign): { title: string; body: string; data: Record<string, string>; icon?: string } {
  return {
    title: c.title,
    body: c.body,
    data: { url: c.url, campaignId: c.id },
    ...(c.icon ? { icon: c.icon } : {}),
  };
}

export function createPushCampaignService(deps: PushCampaignServiceDeps): PushCampaignService {
  const { store, broadcast, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const iso = () => now().toISOString();
  const newId = deps.newId ?? defaultPushCampaignId;

  let chain: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  }

  return {
    broadcastConfigured: broadcast.configured,

    async list() {
      return (await store.read()).sort(byNewest);
    },

    async get(id) {
      return (await store.read()).find((c) => c.id === id) ?? null;
    },

    save(input) {
      return withLock(async (): Promise<SaveResult> => {
        const all = await store.read();
        const at = iso();
        // Поля кампании берём только из входа: обновление не должно тащить за
        // собой удалённые в форме оси таргетинга из прошлой версии.
        const { id: inputId, ...fields } = input;
        if (inputId !== undefined) {
          const idx = all.findIndex((c) => c.id === inputId);
          if (idx === -1) return { ok: false, error: 'not_found' };
          const existing = all[idx];
          if (existing.status !== 'draft') return { ok: false, error: 'already_sent' };
          const campaign: PushCampaign = {
            ...fields,
            id: existing.id,
            status: 'draft',
            createdAt: existing.createdAt,
            updatedAt: at,
            ...(existing.lastSendError ? { lastSendError: existing.lastSendError } : {}),
          };
          all[idx] = campaign;
          await store.write(all);
          return { ok: true, campaign, created: false };
        }
        let id = newId();
        while (all.some((c) => c.id === id)) id = newId();
        const campaign: PushCampaign = { ...fields, id, status: 'draft', createdAt: at, updatedAt: at };
        all.push(campaign);
        await store.write(all);
        return { ok: true, campaign, created: true };
      });
    },

    remove(id) {
      return withLock(async () => {
        const all = await store.read();
        const next = all.filter((c) => c.id !== id);
        if (next.length === all.length) return { ok: false, error: 'not_found' as const };
        await store.write(next);
        return { ok: true as const };
      });
    },

    send(id) {
      return withLock(async (): Promise<SendResult> => {
        const all = await store.read();
        const idx = all.findIndex((c) => c.id === id);
        if (idx === -1) return { ok: false, error: 'not_found' };
        const draft = all[idx];
        if (draft.status !== 'draft') return { ok: false, error: 'already_sent' };
        if (!broadcast.configured) return { ok: false, error: 'push_not_configured' };

        const sentAt = iso();
        const { lastSendError: _dropped, ...clean } = draft;
        void _dropped;
        all[idx] = { ...clean, status: 'sent', sentAt, updatedAt: sentAt };
        await store.write(all);

        try {
          const result = await broadcast.broadcast(toBroadcastRequest(draft));
          const campaign: PushCampaign = { ...clean, status: 'sent', sentAt, updatedAt: sentAt, sendResult: result };
          all[idx] = campaign;
          await store.write(all);
          logger?.info({ id, ...result }, 'push-campaign: sent');
          return { ok: true, campaign };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          logger?.error({ err, id }, 'push-campaign: broadcast failed');
          // Витрина не приняла рассылку — возвращаем черновик, чтобы можно было
          // повторить. Таймаут/сеть попадают сюда же: пуш МОГ уйти, но об этом
          // мы не узнаем; повтор решает админ, видя lastSendError.
          all[idx] = { ...clean, status: 'draft', updatedAt: iso(), lastSendError: reason.slice(0, 500) };
          await store.write(all);
          return {
            ok: false,
            error: err instanceof PushBroadcastError && err.status === undefined && /not configured/.test(err.message)
              ? 'push_not_configured'
              : 'push_broadcast_failed',
            reason,
          };
        }
      });
    },
  };
}
