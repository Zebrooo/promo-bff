/**
 * Search-history reader backed by abkhaz-auto Supabase `search_queries`.
 * The service returns only the bounded recent window needed by SearchChecker.
 */
import { config, type SupabaseConfig } from '../config';
import type { SearchHistoryEntry } from '../promo-selector/checkers/Checker';
import { withTimeout } from '../util/with-timeout';

const HISTORY_DAYS = 30;
const MAX_ROWS = 100;
// The AA storefront abandons the whole promo request after 800 ms. Search is
// an optional gate, so leave enough time to continue with generic candidates.
const SEARCH_HISTORY_TIMEOUT_MS = 300;

export interface SearchHistoryService {
  getSearchHistory(viewerKey: string): Promise<SearchHistoryEntry[]>;
}

interface SearchHistoryRow {
  query?: unknown;
  section?: unknown;
  created_at?: unknown;
}

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function parseRow(row: SearchHistoryRow): SearchHistoryEntry | null {
  if (typeof row.query !== 'string' || typeof row.section !== 'string' || typeof row.created_at !== 'string') {
    return null;
  }
  if (row.query.trim() === '' || row.section.trim() === '' || !Number.isFinite(Date.parse(row.created_at))) {
    return null;
  }
  return { query: row.query, section: row.section, createdAt: row.created_at };
}

export function createSearchHistoryService(
  cfg: SupabaseConfig = config.aaSupabase,
  now: () => Date = () => new Date(),
): SearchHistoryService {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return { getSearchHistory: async () => [] };

  const table = `${url}/rest/v1/search_queries`;

  async function getSearchHistory(viewerKey: string, controller: AbortController): Promise<SearchHistoryEntry[]> {
    const current = now();
    const cutoff = new Date(current.getTime() - HISTORY_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const params = new URLSearchParams({
      select: 'query,section,created_at',
      viewer_key: `eq.${viewerKey}`,
      order: 'created_at.desc',
      limit: String(MAX_ROWS),
    });
    params.append('created_at', `gte.${cutoff}`);
    params.append('created_at', `lte.${current.toISOString()}`);
    const res = await fetch(`${table}?${params.toString()}`, {
      headers: authHeaders(serviceRoleKey),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`search-history-service read failed: HTTP ${res.status}`);

    const body: unknown = await res.json();
    if (!Array.isArray(body)) throw new Error('search-history-service read failed: invalid response');
    return body.flatMap((row) => {
      if (typeof row !== 'object' || row === null) return [];
      const parsed = parseRow(row as SearchHistoryRow);
      return parsed ? [parsed] : [];
    });
  }

  return {
    getSearchHistory: (viewerKey) => {
      const controller = new AbortController();
      return withTimeout(
        getSearchHistory(viewerKey, controller),
        Math.min(timeoutMs, SEARCH_HISTORY_TIMEOUT_MS),
        'searchHistoryService.getSearchHistory',
        controller,
      );
    },
  };
}
