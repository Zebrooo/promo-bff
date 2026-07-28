import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAaAdminStore } from './aa-admin-store';

const cfg = { url: 'https://sb-aa.example.com', serviceRoleKey: 'aa-srk', timeoutMs: 1000 };

afterEach(() => vi.restoreAllMocks());

describe('createAaAdminStore (no-op fallback)', () => {
  it('getCanaryState/listExperiments return empty shapes when unconfigured', async () => {
    const store = createAaAdminStore({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(store.getCanaryState()).resolves.toBeNull();
    await expect(store.listExperiments()).resolves.toEqual({ experiments: [], variants: [] });
  });

  it('mutations throw when unconfigured (defense in depth — server.ts should 503 first)', async () => {
    const store = createAaAdminStore({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(store.setCanaryPct(10, 'promo-cabinet')).rejects.toThrow(/unconfigured/);
  });
});

describe('createAaAdminStore.getCanaryState', () => {
  it('normalises numeric pct (PostgREST may return it as a string)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify([{ colour: 'blue', pct: '25', updated_at: 't', updated_by: 'x' }]), { status: 200 }),
    );
    const store = createAaAdminStore(cfg);
    await expect(store.getCanaryState()).resolves.toEqual({ colour: 'blue', pct: 25, updated_at: 't', updated_by: 'x' });
  });

  it('returns null when the singleton row is missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify([]), { status: 200 }));
    const store = createAaAdminStore(cfg);
    await expect(store.getCanaryState()).resolves.toBeNull();
  });
});

describe('createAaAdminStore.setCanaryPct', () => {
  it('rejects colour=null with canary_not_active semantics (no PATCH issued)', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(JSON.stringify([{ colour: null }]), { status: 200 }));
    const store = createAaAdminStore(cfg);
    const result = await store.setCanaryPct(10, 'promo-cabinet');
    expect(result).toEqual({ ok: false, error: 'Канарейка не включена на сервере' });
    // Only the colour read happened — no PATCH follow-up.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  // -1/100/NaN отклоняются до fetch; 1.5 сервис truncates до 1 (та же
  // семантика, что actions.ts `Math.trunc(Number(pct))` — намеренное
  // зеркало витрины). Строгая проверка на целое — в HTTP-слое (server.ts),
  // сервис — вторая линия защиты для прямых вызовов.
  it.each([-1, 100, NaN])('rejects out-of-range/non-finite pct=%s before any fetch', async (bad) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const store = createAaAdminStore(cfg);
    const result = await store.setCanaryPct(bad, 'promo-cabinet');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('truncates a fractional pct instead of rejecting (mirrors actions.ts Math.trunc)', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL) => {
      if (String(url).includes('select=colour')) {
        return new Response(JSON.stringify([{ colour: 'blue' }]), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    const store = createAaAdminStore(cfg);
    const result = await store.setCanaryPct(1.9, 'promo-cabinet');
    expect(result).toEqual({ ok: true });
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(patchCall?.[1]?.body))).toMatchObject({ pct: 1 });
  });

  it('rejects a numeric string via the type guard even though Number("10") would parse', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const store = createAaAdminStore(cfg);
    // @ts-expect-error — тест на рантайм-поведение при обходе типов (прямой вызов не через HTTP-слой).
    const result = await store.setCanaryPct('not-a-number', 'promo-cabinet');
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts boundary values 0 and 99', async () => {
    for (const pct of [0, 99]) {
      vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL) => {
        if (String(url).includes('select=colour')) {
          return new Response(JSON.stringify([{ colour: 'green' }]), { status: 200 });
        }
        return new Response(null, { status: 204 });
      }) as typeof fetch);
      const store = createAaAdminStore(cfg);
      const result = await store.setCanaryPct(pct, 'promo-cabinet');
      expect(result).toEqual({ ok: true });
      vi.restoreAllMocks();
    }
  });

  it('writes updated_by = actor and a fresh updated_at on success', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL) => {
      if (String(url).includes('select=colour')) {
        return new Response(JSON.stringify([{ colour: 'blue' }]), { status: 200 });
      }
      return new Response(null, { status: 204 });
    }) as typeof fetch);
    const store = createAaAdminStore(cfg);
    await store.setCanaryPct(50, 'promo-cabinet');
    const patchCall = fetchMock.mock.calls.find(([, init]) => init?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const sent = JSON.parse(String(patchCall?.[1]?.body));
    expect(sent).toMatchObject({ pct: 50, updated_by: 'promo-cabinet' });
    expect(typeof sent.updated_at).toBe('string');
  });
});

describe('createAaAdminStore.createExperiment', () => {
  const validVariants = [
    { key: 'control', weight: 1, is_control: true },
    { key: 'a', weight: 1, is_control: false },
  ];

  it('rejects fewer than 2 variants without any fetch', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const store = createAaAdminStore(cfg);
    const result = await store.createExperiment(
      {
        key: 'my-exp',
        title: 'T',
        surface: 'client',
        variants: [{ key: 'control', weight: 1, is_control: true }],
      },
      'promo-cabinet',
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a non-kebab key', async () => {
    const store = createAaAdminStore(cfg);
    const result = await store.createExperiment(
      { key: 'Not Kebab!', title: 'T', surface: 'client', variants: validVariants },
      'promo-cabinet',
    );
    expect(result.ok).toBe(false);
  });

  it.each([NaN, Infinity])('rejects a non-finite variant weight=%s without any fetch', async (bad) => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    const store = createAaAdminStore(cfg);
    const result = await store.createExperiment(
      {
        key: 'my-exp',
        title: 'T',
        surface: 'client',
        variants: [{ key: 'control', weight: bad, is_control: true }, { key: 'a', weight: 1, is_control: false }],
      },
      'promo-cabinet',
    );
    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a 23505 unique_violation to code:"key_exists" instead of a generic error', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ code: '23505', message: 'duplicate key' }), { status: 409 }),
    );
    const store = createAaAdminStore(cfg);
    const result = await store.createExperiment(
      { key: 'my-exp', title: 'T', surface: 'client', variants: validVariants },
      'promo-cabinet',
    );
    expect(result).toEqual({ ok: false, error: 'Ключ уже существует', code: 'key_exists' });
  });

  it('writes experiment_audit with actor:null and action prefixed by the caller service id', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 201 }));
    const store = createAaAdminStore(cfg);
    const result = await store.createExperiment(
      { key: 'my-exp', title: 'T', surface: 'client', variants: validVariants },
      'promo-cabinet',
    );
    expect(result).toEqual({ ok: true });
    // writeAudit — fire-and-forget (не await'ится вызывающим кодом, см.
    // комментарий в aa-admin-store.ts), так что запрос может ещё лежать в
    // микротаск-очереди в момент, когда createExperiment уже вернулся.
    await vi.waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('experiment_audit'))).toBe(true);
    });
    const auditCall = fetchMock.mock.calls.find(([url]) => String(url).includes('experiment_audit'));
    const sent = JSON.parse(String(auditCall?.[1]?.body));
    expect(sent).toMatchObject({ experiment_key: 'my-exp', actor: null, action: 'promo-cabinet:create' });
  });

  it('does not fail the mutation when the audit write itself fails (fire-and-forget)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (url: string | URL) => {
      if (String(url).includes('experiment_audit')) return new Response('nope', { status: 500 });
      return new Response(null, { status: 201 });
    }) as typeof fetch);
    const store = createAaAdminStore(cfg);
    const result = await store.createExperiment(
      { key: 'my-exp', title: 'T', surface: 'client', variants: validVariants },
      'promo-cabinet',
    );
    expect(result).toEqual({ ok: true });
    // Регрессионный замок ровно на "fire-and-forget" свойство: мутация уже
    // вернула ok:true ДО того, как аудит-запрос вообще успел провалиться —
    // ждём, пока отложенный warn всё же случится.
    await vi.waitFor(() => expect(warnSpy).toHaveBeenCalled());
  });
});

describe('createAaAdminStore error handling', () => {
  it('surfaces non-JSON PostgREST/proxy error bodies without throwing on .json()', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>Bad Gateway</html>', { status: 502 }));
    const store = createAaAdminStore(cfg);
    await expect(store.getCanaryState()).rejects.toThrow(/HTTP 502/);
  });
});
