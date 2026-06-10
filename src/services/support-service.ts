/**
 * AI support orchestration (promozavr).
 *
 * The abkhaz-auto site calls this service directly (cross-origin) so the support
 * backend lives entirely on our infra: it verifies the site user's Supabase
 * access token, stores the conversation/messages in the abkhaz-auto Supabase via
 * the service-role PostgREST API, relays the message to the local claudeclaw
 * agent (HMAC), and ingests claudeclaw's async callback (HMAC). The user's
 * browser sees the bot reply via its own Supabase Realtime subscription.
 */
import crypto from 'node:crypto';
import { config } from '../config';

const SUPPORT_WELCOME =
  'Здравствуйте! Я — ассистент поддержки «Абхаз Авто». Опишите вопрос — помогу с объявлениями, оплатой, безопасностью и другим. Если не справлюсь, подскажу, как связаться с командой.';
const FALLBACK =
  'Извините, поддержка сейчас недоступна. Напишите на support@abkhaz-avto.ru или повторите чуть позже.';

const aa = config.aaSupabase;
const sup = config.support;

function aaHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    apikey: aa.serviceRoleKey,
    Authorization: `Bearer ${aa.serviceRoleKey}`,
    'content-type': 'application/json',
    ...extra,
  };
}

function hmacHex(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
function verifyHmac(secret: string, body: string, sig: string): boolean {
  if (!sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(hmacHex(secret, body));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Verify the site user's Supabase access token via GoTrue → user id (or null). */
export async function verifyUser(token: string): Promise<string | null> {
  if (!token || !aa.url) return null;
  try {
    const res = await fetch(`${aa.url}/auth/v1/user`, {
      headers: { apikey: aa.serviceRoleKey, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(sup.supabaseTimeoutMs),
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { id?: string };
    return u?.id ?? null;
  } catch {
    return null;
  }
}

export interface SupportMsgRow {
  id: number;
  conversation_id: string;
  role: 'user' | 'bot';
  body: string;
  escalate: boolean;
  created_at: string;
}

async function insertMessage(
  conversationId: string,
  role: 'user' | 'bot',
  body: string,
  escalate: boolean,
): Promise<SupportMsgRow | null> {
  // The promo→apsoft1 Supabase link is occasionally slow/flaky; retry once so a
  // transient timeout doesn't drop the bot reply.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${aa.url}/rest/v1/support_messages`, {
        method: 'POST',
        headers: aaHeaders({ Prefer: 'return=representation' }),
        body: JSON.stringify({ conversation_id: conversationId, role, body, escalate }),
        signal: AbortSignal.timeout(sup.supabaseTimeoutMs),
      });
      if (!res.ok) return null;
      const rows = (await res.json().catch(() => [])) as SupportMsgRow[];
      return rows[0] ?? null;
    } catch (e) {
      if (attempt === 1) throw e;
    }
  }
  return null;
}

async function getOrCreateConversation(userId: string): Promise<string | null> {
  const sel = `${aa.url}/rest/v1/support_conversations?user_id=eq.${encodeURIComponent(userId)}&select=id&limit=1`;
  const g = await fetch(sel, { headers: aaHeaders(), signal: AbortSignal.timeout(sup.supabaseTimeoutMs) });
  if (g.ok) {
    const rows = (await g.json()) as { id: string }[];
    if (rows[0]) return rows[0].id;
  }
  const c = await fetch(`${aa.url}/rest/v1/support_conversations`, {
    method: 'POST',
    headers: aaHeaders({ Prefer: 'return=representation' }),
    body: JSON.stringify({ user_id: userId }),
    signal: AbortSignal.timeout(sup.supabaseTimeoutMs),
  });
  if (c.ok) {
    const rows = (await c.json()) as { id: string }[];
    const id = rows[0]?.id;
    if (id) {
      await insertMessage(id, 'bot', SUPPORT_WELCOME, false);
      return id;
    }
  }
  // UNIQUE(user_id) race — re-select.
  const g2 = await fetch(sel, { headers: aaHeaders(), signal: AbortSignal.timeout(sup.supabaseTimeoutMs) });
  if (g2.ok) {
    const rows = (await g2.json()) as { id: string }[];
    return rows[0]?.id ?? null;
  }
  return null;
}

async function userMsgCountLastHour(conversationId: string): Promise<number> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const qs = `conversation_id=eq.${conversationId}&role=eq.user&created_at=gte.${since}&select=id`;
  const res = await fetch(`${aa.url}/rest/v1/support_messages?${qs}`, {
    headers: aaHeaders({ Prefer: 'count=exact', Range: '0-0' }),
    signal: AbortSignal.timeout(sup.supabaseTimeoutMs),
  });
  await res.json().catch(() => undefined);
  const cr = res.headers.get('content-range');
  return cr ? Number(cr.split('/')[1]) || 0 : 0;
}

export type SendResult =
  | { ok: true; conversationId: string; message: SupportMsgRow | null }
  | { ok: false; status: number; error: string };

export async function handleSupportMessage(token: string, message: unknown): Promise<SendResult> {
  const userId = await verifyUser(token);
  if (!userId) return { ok: false, status: 401, error: 'unauthorized' };

  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return { ok: false, status: 400, error: 'empty_message' };
  if (text.length > 4000) return { ok: false, status: 400, error: 'too_long' };

  const conversationId = await getOrCreateConversation(userId);
  if (!conversationId) return { ok: false, status: 500, error: 'conv_failed' };

  if ((await userMsgCountLastHour(conversationId)) >= sup.ratePerHour) {
    return { ok: false, status: 429, error: 'rate_limited' };
  }

  const userMessage = await insertMessage(conversationId, 'user', text, false);

  const payload = JSON.stringify({ conversationId, prompt: text });
  try {
    const r = await fetch(sup.claudeclawWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': hmacHex(sup.webhookSecret, payload) },
      body: payload,
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new Error(`webhook ${r.status}`);
  } catch {
    await insertMessage(conversationId, 'bot', FALLBACK, false);
  }
  return { ok: true, conversationId, message: userMessage };
}

export type CallbackResult = { ok: boolean; status: number };

export async function handleSupportCallback(rawBody: string, sig: string): Promise<CallbackResult> {
  if (!sup.callbackSecret || !verifyHmac(sup.callbackSecret, rawBody, sig)) {
    return { ok: false, status: 401 };
  }
  let b: { conversationId?: string; reply?: string; escalate?: boolean };
  try {
    b = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400 };
  }
  const conversationId = String(b.conversationId ?? '');
  const reply = (b.reply ?? '').trim();
  if (!conversationId || !reply) return { ok: false, status: 400 };
  await insertMessage(conversationId, 'bot', reply, !!b.escalate);
  return { ok: true, status: 200 };
}
