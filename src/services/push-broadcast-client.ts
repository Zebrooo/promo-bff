/**
 * Клиент рассылки FCM-пушей через витрину: POST {AA_BASE_URL}/api/v1/push/broadcast.
 *
 * FCM-инфраструктура (device_tokens, sendPushToUser) живёт в abkhaz-auto,
 * поэтому BFF сам в FCM не ходит — просит витрину разослать. Авторизация —
 * служебный тикет (Ed25519, @zebrooo/service-ticket), как у всех межсервисных
 * вызовов в этой системе: BFF подписывает своим приватным ключом
 * (PROMO_TICKET_PRIVATE_KEY), витрина проверяет публичным (src=promo-bff,
 * dst=abkhaz-auto).
 *
 * Контракт ручки витрины (см. promo-cabinet/docs/2026-09-09-push-campaigns.md):
 *   → { title, body, data?: Record<string,string>, icon?, userIds?: string[] }
 *   ← 200 { ok: true, users, attempted, delivered, failed }
 * userIds не передан = всем пользователям с FCM-токенами.
 */
import { issueServiceTicket, SERVICE_TICKET_HEADER } from '@zebrooo/service-ticket';
import type { AaPushConfig } from '../config';
import { withTimeout } from '../util/with-timeout';
import { pushSendResultSchema, type PushSendResult } from './push-campaign-schema';

export interface PushBroadcastRequest {
  title: string;
  body: string;
  /** Полезная нагрузка пуша (строки — так требует FCM data). */
  data?: Record<string, string>;
  icon?: string;
  /** Пусто/нет = все пользователи с токенами. */
  userIds?: string[];
}

export interface PushBroadcastClient {
  /** false = AA_BASE_URL / PROMO_TICKET_PRIVATE_KEY не заданы — слать некуда. */
  configured: boolean;
  broadcast(req: PushBroadcastRequest): Promise<PushSendResult>;
}

/** Витрина ответила не-2xx или не тем телом — наружу уходит 502 push_broadcast_failed. */
export class PushBroadcastError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'PushBroadcastError';
  }
}

export interface PushBroadcastClientDeps {
  fetchImpl?: typeof fetch;
  /** Инжектится в тестах, чтобы не генерировать ключи. */
  issueTicket?: (opts: { src: string; dst: string; privateKey: string }) => string;
}

export function createPushBroadcastClient(cfg: AaPushConfig, deps: PushBroadcastClientDeps = {}): PushBroadcastClient {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const issue = deps.issueTicket ?? issueServiceTicket;
  const configured = Boolean(cfg.baseUrl && cfg.ticketPrivateKey);

  return {
    configured,
    async broadcast(req) {
      if (!configured) throw new PushBroadcastError('push broadcast is not configured (AA_BASE_URL / PROMO_TICKET_PRIVATE_KEY)');
      const ticket = issue({ src: cfg.ticketSrc, dst: cfg.ticketDst, privateKey: cfg.ticketPrivateKey });
      const res = await withTimeout(
        fetchImpl(`${cfg.baseUrl}${cfg.broadcastPath}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', [SERVICE_TICKET_HEADER]: ticket },
          body: JSON.stringify(req),
        }),
        cfg.timeoutMs,
        'push-broadcast',
      );
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = null;
      }
      if (!res.ok) {
        const reason = typeof json === 'object' && json !== null && typeof (json as { error?: unknown }).error === 'string'
          ? (json as { error: string }).error
          : text.slice(0, 200);
        throw new PushBroadcastError(`abkhaz-auto broadcast returned ${res.status}${reason ? `: ${reason}` : ''}`, res.status);
      }
      const parsed = pushSendResultSchema.safeParse(json);
      if (!parsed.success) throw new PushBroadcastError('abkhaz-auto broadcast returned an unexpected body', res.status);
      return parsed.data;
    },
  };
}
