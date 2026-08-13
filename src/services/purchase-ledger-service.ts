/**
 * Ledger reader for the two behavioural checkers (Purchases, Balance): pack
 * purchases and net wallet movement, both derived from `ledger_postings` on
 * the abkhaz-auto Supabase (0041_wallet_ledger.sql). Wallet CURRENT balance
 * is a separate concern — see `balance-service.ts` (denormalized column,
 * no ledger read needed); this service only reads the append-only journal.
 */
import { config, type SupabaseConfig } from '../config';
import type { PurchaseEntry } from '../promo-selector/checkers/Checker';
import { withTimeout } from '../util/with-timeout';

const TIMEOUT_MS = 300;
const KNOWN_PACKS = new Set(['bump', 'premium', 'vip']);

export interface PurchaseLedgerService {
  getPurchases(userId: string, sinceMs?: number): Promise<PurchaseEntry[]>;
  getMovement(userId: string, sinceMs?: number): Promise<number>;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

async function findAccountId(
  base: string,
  key: string,
  userId: string,
  controller: AbortController,
): Promise<number | null> {
  const params = new URLSearchParams({
    owner_user_id: `eq.${userId}`,
    kind: 'eq.liability',
    select: 'id',
  });
  const res = await fetch(`${base}/rest/v1/ledger_accounts?${params}`, {
    headers: authHeaders(key),
    signal: controller.signal,
  });
  if (!res.ok) throw new Error(`purchase-ledger-service account lookup failed: HTTP ${res.status}`);
  const rows = (await res.json()) as Array<{ id: number }>;
  return rows[0]?.id ?? null;
}

interface PurchaseRow {
  amount_kopecks: number | string;
  created_at: string;
  ledger_transactions: { type: string; subject_kind: string; meta: Record<string, unknown> | null };
}

function parsePurchaseRow(row: PurchaseRow): PurchaseEntry | null {
  const pack = row.ledger_transactions?.meta?.pack;
  if (typeof pack !== 'string' || !KNOWN_PACKS.has(pack)) return null;
  return {
    pack: pack as PurchaseEntry['pack'],
    amountKopecks: Math.abs(Number(row.amount_kopecks)),
    createdAt: row.created_at,
  };
}

export function createPurchaseLedgerService(cfg: SupabaseConfig = config.aaSupabase): PurchaseLedgerService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) {
    return { getPurchases: async () => [], getMovement: async () => 0 };
  }
  const budget = Math.min(timeoutMs, TIMEOUT_MS);

  async function getPurchases(userId: string, sinceMs?: number): Promise<PurchaseEntry[]> {
    const controller = new AbortController();
    const accountId = await findAccountId(url, serviceRoleKey, userId, controller);
    if (accountId === null) return [];
    const params = new URLSearchParams({
      select: 'amount_kopecks,created_at,ledger_transactions!inner(type,subject_kind,meta)',
      account_id: `eq.${accountId}`,
      'ledger_transactions.type': 'eq.charge',
      'ledger_transactions.subject_kind': 'eq.listing',
    });
    if (sinceMs !== undefined) params.append('created_at', `gte.${new Date(sinceMs).toISOString()}`);
    const res = await fetch(`${url}/rest/v1/ledger_postings?${params}`, {
      headers: authHeaders(serviceRoleKey),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`purchase-ledger-service purchases read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as PurchaseRow[];
    return rows.flatMap((row) => {
      const parsed = parsePurchaseRow(row);
      return parsed ? [parsed] : [];
    });
  }

  async function getMovement(userId: string, sinceMs?: number): Promise<number> {
    const controller = new AbortController();
    const accountId = await findAccountId(url, serviceRoleKey, userId, controller);
    if (accountId === null) return 0;
    const params = new URLSearchParams({
      select: 'amount_kopecks',
      account_id: `eq.${accountId}`,
    });
    if (sinceMs !== undefined) params.append('created_at', `gte.${new Date(sinceMs).toISOString()}`);
    const res = await fetch(`${url}/rest/v1/ledger_postings?${params}`, {
      headers: authHeaders(serviceRoleKey),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`purchase-ledger-service movement read failed: HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{ amount_kopecks: number | string }>;
    return rows.reduce((sum, r) => sum + Number(r.amount_kopecks), 0);
  }

  return {
    getPurchases: (userId, sinceMs) => withTimeout(getPurchases(userId, sinceMs), budget, 'purchaseLedgerService.getPurchases'),
    getMovement: (userId, sinceMs) => withTimeout(getMovement(userId, sinceMs), budget, 'purchaseLedgerService.getMovement'),
  };
}
