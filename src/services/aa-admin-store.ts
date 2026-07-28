/**
 * Пульт канарейки релиза и A/B-экспериментов abkhaz-auto — серверная сторона
 * ручек /aa-admin/* (перенос из серверных экшенов витрины
 * src/app/admin/experiments/actions.ts, чтобы кабинет мог управлять test/prod
 * стендами без прямого доступа к их Supabase). Семантика мутаций (проверки,
 * какие поля пишутся) скопирована оттуда 1:1 — источник правды для схемы
 * остаётся в витрине, здесь только зеркало.
 *
 * Same pattern as analytics-store/referral-config-service: raw fetch на
 * PostgREST, service-role ключ, withTimeout. В отличие от них — БЕЗ no-op
 * fallback: вызывающий код в server.ts обязан отсечь несконфигурённое
 * окружение 503-м ДО обращения к сервису (двух разных Supabase здесь два,
 * молчаливый no-op на одном из них замаскировал бы «забыли завести test-env»).
 * createNoopStore всё равно есть — как страховка, если этот инвариант
 * когда-нибудь нарушат в server.ts.
 */
import type { SupabaseConfig } from '../config';
import { withTimeout } from '../util/with-timeout';

export interface CanaryStateRow {
  colour: 'blue' | 'green' | null;
  pct: number;
  updated_at: string;
  updated_by: string | null;
}

export interface ExperimentRow {
  key: string;
  title: string;
  status: 'draft' | 'running' | 'paused' | 'completed';
  kill_switch: boolean;
  rollout_pct: number;
  salt: number;
  surface: 'client' | 'dynamic';
  targeting: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface ExperimentVariantRow {
  experiment_key: string;
  key: string;
  weight: number;
  is_control: boolean;
  payload: Record<string, unknown>;
  position: number;
}

export type AdminResult = { ok: true } | { ok: false; error: string };

export interface CreateExperimentInput {
  key: string;
  title: string;
  surface: string;
  variants: { key: string; weight: number; is_control: boolean }[];
}

export interface PatchExperimentInput {
  rollout_pct?: number;
  status?: string;
  kill_switch?: boolean;
  surface?: string;
  authOnly?: boolean;
}

export interface AaAdminStore {
  /** false = Supabase для этого env не задан (пустой url/key) — server.ts
   *  должен отсечь запрос 503-м, не дожидаясь unconfigured-исключения. */
  configured: boolean;
  getCanaryState(): Promise<CanaryStateRow | null>;
  setCanaryPct(pct: number, actor: string): Promise<AdminResult>;
  listExperiments(): Promise<{ experiments: ExperimentRow[]; variants: ExperimentVariantRow[] }>;
  createExperiment(input: CreateExperimentInput): Promise<AdminResult>;
  patchExperiment(key: string, patch: PatchExperimentInput): Promise<AdminResult>;
  bumpSalt(key: string): Promise<AdminResult>;
  renameVariant(expKey: string, from: string, to: string): Promise<AdminResult>;
  saveVariantWeights(key: string, weights: { key: string; weight: number }[]): Promise<AdminResult>;
}

// Те же правила, что в витрине (actions.ts) — расходиться с ними нельзя,
// иначе BFF примет то, что витрина бы отвергла (или наоборот).
const STATUSES = ['draft', 'running', 'paused', 'completed'] as const;
const SURFACES = ['client', 'dynamic'] as const;
const KEY_RE = /^[a-z0-9][a-z0-9-]{1,48}$/;

function authHeaders(key: string): Record<string, string> {
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function createNoopStore(): AaAdminStore {
  const unconfigured = (): never => {
    throw new Error('aa-admin-store: called with an unconfigured Supabase env');
  };
  return {
    configured: false,
    getCanaryState: async () => null,
    setCanaryPct: async () => unconfigured(),
    listExperiments: async () => ({ experiments: [], variants: [] }),
    createExperiment: async () => unconfigured(),
    patchExperiment: async () => unconfigured(),
    bumpSalt: async () => unconfigured(),
    renameVariant: async () => unconfigured(),
    saveVariantWeights: async () => unconfigured(),
  };
}

export function createAaAdminStore(cfg: SupabaseConfig): AaAdminStore {
  const { url, serviceRoleKey, timeoutMs } = cfg;
  if (!url || !serviceRoleKey) return createNoopStore();

  async function pgFetch(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${url}/rest/v1/${path}`, {
      ...init,
      headers: { ...authHeaders(serviceRoleKey), 'content-type': 'application/json', ...init.headers },
    });
  }

  // PostgREST на ошибке (4xx/5xx) обычно отдаёт JSON {message,...}, но не
  // гарантированно (502 от прокси — голый HTML/текст) — .json().catch не даёт
  // ошибке парсинга затереть настоящую причину сбоя.
  async function errorMessage(res: Response): Promise<string> {
    const body = await res.json().catch(() => null);
    const msg = body && typeof body === 'object' ? (body as { message?: string }).message : undefined;
    return msg ?? `HTTP ${res.status}`;
  }

  async function getCanaryState(): Promise<CanaryStateRow | null> {
    const res = await pgFetch('canary_state?id=eq.1&select=colour,pct,updated_at,updated_by');
    if (!res.ok) throw new Error(`aa-admin-store getCanaryState failed: ${await errorMessage(res)}`);
    const rows = (await res.json()) as CanaryStateRow[];
    const row = rows[0];
    // PostgREST/PostgreSQL numeric иногда доезжает JSON-строкой, не числом
    // (как и в витрине — see page.tsx `Number(canaryDb?.pct)`); нормализуем тут,
    // чтобы вызывающий код мог полагаться на реальный number.
    return row ? { ...row, pct: Number(row.pct) || 0 } : null;
  }

  async function setCanaryPct(pct: number, actor: string): Promise<AdminResult> {
    const p = Math.trunc(Number(pct));
    if (!Number.isFinite(p) || p < 0 || p > 99) return { ok: false, error: 'Процент: целое 0..99' };

    // Колонку colour пишет только bluegreen.sh на сервере — если она NULL,
    // роутера нет, и процент раздавать некому (см. миграция 0194).
    const stRes = await pgFetch('canary_state?id=eq.1&select=colour');
    if (!stRes.ok) return { ok: false, error: await errorMessage(stRes) };
    const st = ((await stRes.json()) as { colour: string | null }[])[0];
    if (!st?.colour) return { ok: false, error: 'Канарейка не включена на сервере' };

    const res = await pgFetch('canary_state?id=eq.1', {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ pct: p, updated_at: new Date().toISOString(), updated_by: actor }),
    });
    if (!res.ok) return { ok: false, error: await errorMessage(res) };
    return { ok: true };
  }

  async function listExperiments(): Promise<{ experiments: ExperimentRow[]; variants: ExperimentVariantRow[] }> {
    const [expRes, varRes] = await Promise.all([
      pgFetch('experiments?select=*&order=created_at.desc'),
      pgFetch('experiment_variants?select=*&order=position.asc'),
    ]);
    if (!expRes.ok) throw new Error(`aa-admin-store listExperiments failed: ${await errorMessage(expRes)}`);
    if (!varRes.ok) throw new Error(`aa-admin-store listExperiments failed: ${await errorMessage(varRes)}`);
    const rawExperiments = (await expRes.json()) as ExperimentRow[];
    const variants = (await varRes.json()) as ExperimentVariantRow[];
    // rollout_pct — numeric(5,2), тот же прогон через Number(), что в витрине.
    const experiments = rawExperiments.map((e) => ({ ...e, rollout_pct: Number(e.rollout_pct) || 0 }));
    return { experiments, variants };
  }

  async function createExperiment(input: CreateExperimentInput): Promise<AdminResult> {
    const key = input.key.trim();
    if (!KEY_RE.test(key)) return { ok: false, error: 'Ключ: kebab-case, латиница/цифры, 2–49 симв.' };
    if (!input.title.trim()) return { ok: false, error: 'Нужен заголовок' };
    if (!SURFACES.includes(input.surface as (typeof SURFACES)[number])) {
      return { ok: false, error: 'Некорректный surface' };
    }
    const vars = input.variants.filter((v) => v.key.trim());
    if (vars.length < 2) return { ok: false, error: 'Минимум 2 варианта' };
    if (!vars.some((v) => v.is_control)) return { ok: false, error: 'Нужен control-вариант' };
    if (new Set(vars.map((v) => v.key)).size !== vars.length) {
      return { ok: false, error: 'Ключи вариантов должны быть уникальны' };
    }

    const expRes = await pgFetch('experiments', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ key, title: input.title.trim(), surface: input.surface, status: 'draft', rollout_pct: 0 }),
    });
    if (!expRes.ok) {
      // 23505 = unique_violation (PostgREST прокидывает Postgres SQLSTATE в теле).
      const body = await expRes.json().catch(() => null);
      const code = body && typeof body === 'object' ? (body as { code?: string }).code : undefined;
      return { ok: false, error: code === '23505' ? 'Ключ уже существует' : await errorMessage(expRes) };
    }

    const varRes = await pgFetch('experiment_variants', {
      method: 'POST',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(
        vars.map((v, i) => ({
          experiment_key: key,
          key: v.key.trim(),
          weight: Math.max(0, Math.trunc(v.weight)),
          is_control: v.is_control,
          position: i,
        })),
      ),
    });
    if (!varRes.ok) {
      // Откат, чтобы не осталось «эксперимента без вариантов» — как в actions.ts.
      await pgFetch(`experiments?key=eq.${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers: { Prefer: 'return=minimal' },
      }).catch(() => {});
      return { ok: false, error: await errorMessage(varRes) };
    }
    return { ok: true };
  }

  async function patchExperiment(key: string, patch: PatchExperimentInput): Promise<AdminResult> {
    const beforeRes = await pgFetch(`experiments?key=eq.${encodeURIComponent(key)}&select=*`);
    if (!beforeRes.ok) return { ok: false, error: await errorMessage(beforeRes) };
    const before = ((await beforeRes.json()) as ExperimentRow[])[0];
    if (!before) return { ok: false, error: 'Эксперимент не найден' };

    const upd: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.rollout_pct !== undefined) {
      const p = Number(patch.rollout_pct);
      if (!Number.isFinite(p) || p < 0 || p > 100) return { ok: false, error: 'rollout 0..100' };
      upd.rollout_pct = p;
    }
    if (patch.status !== undefined) {
      if (!STATUSES.includes(patch.status as (typeof STATUSES)[number])) {
        return { ok: false, error: 'Некорректный статус' };
      }
      upd.status = patch.status;
    }
    if (patch.kill_switch !== undefined) upd.kill_switch = !!patch.kill_switch;
    if (patch.surface !== undefined) {
      if (!SURFACES.includes(patch.surface as (typeof SURFACES)[number])) {
        return { ok: false, error: 'Некорректный surface' };
      }
      upd.surface = patch.surface;
    }
    if (patch.authOnly !== undefined) {
      const t = (before.targeting ?? {}) as Record<string, unknown>;
      upd.targeting = { ...t, authOnly: !!patch.authOnly };
    }

    const res = await pgFetch(`experiments?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify(upd),
    });
    if (!res.ok) return { ok: false, error: await errorMessage(res) };
    return { ok: true };
  }

  async function bumpSalt(key: string): Promise<AdminResult> {
    const beforeRes = await pgFetch(`experiments?key=eq.${encodeURIComponent(key)}&select=salt`);
    if (!beforeRes.ok) return { ok: false, error: await errorMessage(beforeRes) };
    const before = ((await beforeRes.json()) as { salt: number }[])[0];
    if (!before) return { ok: false, error: 'Эксперимент не найден' };
    const next = (Number(before.salt) || 1) + 1;
    const res = await pgFetch(`experiments?key=eq.${encodeURIComponent(key)}`, {
      method: 'PATCH',
      headers: { Prefer: 'return=minimal' },
      body: JSON.stringify({ salt: next, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) return { ok: false, error: await errorMessage(res) };
    return { ok: true };
  }

  async function renameVariant(expKey: string, from: string, to: string): Promise<AdminResult> {
    const next = to.trim();
    if (!KEY_RE.test(next) && next !== 'control') {
      return { ok: false, error: 'Ключ варианта: kebab-case, латиница/цифры' };
    }
    // Атомарность на PK (experiment_key, key): дубль ловится констрейнтом
    // (23505), а не гоночным select-ом; отсутствие исходного — по числу
    // обновлённых строк (как в actions.ts).
    const res = await pgFetch(
      `experiment_variants?experiment_key=eq.${encodeURIComponent(expKey)}&key=eq.${encodeURIComponent(from)}`,
      {
        method: 'PATCH',
        headers: { Prefer: 'return=representation' },
        body: JSON.stringify({ key: next }),
      },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      const code = body && typeof body === 'object' ? (body as { code?: string }).code : undefined;
      return { ok: false, error: code === '23505' ? `Вариант «${next}» уже есть` : await errorMessage(res) };
    }
    const updated = (await res.json().catch(() => [])) as { key: string }[];
    if (!updated.length) return { ok: false, error: `Варианта «${from}» нет` };
    return { ok: true };
  }

  async function saveVariantWeights(
    key: string,
    weights: { key: string; weight: number }[],
  ): Promise<AdminResult> {
    for (const w of weights) {
      const weight = Math.max(0, Math.trunc(Number(w.weight)));
      if (!Number.isFinite(weight)) return { ok: false, error: `Некорректный вес для ${w.key}` };
      const res = await pgFetch(
        `experiment_variants?experiment_key=eq.${encodeURIComponent(key)}&key=eq.${encodeURIComponent(w.key)}`,
        {
          method: 'PATCH',
          headers: { Prefer: 'return=minimal' },
          body: JSON.stringify({ weight }),
        },
      );
      if (!res.ok) return { ok: false, error: await errorMessage(res) };
    }
    return { ok: true };
  }

  // withTimeout на каждый публичный метод — единая точка таймаутов, как во
  // всех остальных сервисах репо (see with-timeout.ts).
  return {
    configured: true,
    getCanaryState: () => withTimeout(getCanaryState(), timeoutMs, 'aaAdminStore.getCanaryState'),
    setCanaryPct: (pct, actor) => withTimeout(setCanaryPct(pct, actor), timeoutMs, 'aaAdminStore.setCanaryPct'),
    listExperiments: () => withTimeout(listExperiments(), timeoutMs, 'aaAdminStore.listExperiments'),
    createExperiment: (input) => withTimeout(createExperiment(input), timeoutMs, 'aaAdminStore.createExperiment'),
    patchExperiment: (key, patch) =>
      withTimeout(patchExperiment(key, patch), timeoutMs, 'aaAdminStore.patchExperiment'),
    bumpSalt: (key) => withTimeout(bumpSalt(key), timeoutMs, 'aaAdminStore.bumpSalt'),
    renameVariant: (expKey, from, to) =>
      withTimeout(renameVariant(expKey, from, to), timeoutMs, 'aaAdminStore.renameVariant'),
    saveVariantWeights: (key, weights) =>
      withTimeout(saveVariantWeights(key, weights), timeoutMs, 'aaAdminStore.saveVariantWeights'),
  };
}
