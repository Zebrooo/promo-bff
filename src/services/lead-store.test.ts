import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLeadStore, LEADS_MAX_LIMIT } from './lead-store';

const cfg = { url: 'https://sb.example.com', serviceRoleKey: 'srk', timeoutMs: 1000 };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLeadStore (no-op fallback)', () => {
  it('returns an empty list when Supabase is unconfigured', async () => {
    const store = createLeadStore({ url: '', serviceRoleKey: '', timeoutMs: 1000 });
    await expect(store.getLeads({})).resolves.toEqual([]);
  });
});

describe('createLeadStore (Supabase)', () => {
  const rows = [
    {
      created_at: '2026-08-19T10:00:00Z',
      promo_id: 'divany',
      promo_title: 'Диваны',
      page: '/mebel',
      name: 'Пётр',
      phone: '+79781234567',
    },
    // Пустые поля приходят null'ами — маппинг обязан отдавать строки.
    { created_at: '2026-08-18T09:00:00Z', promo_id: 'divany', promo_title: null, page: null, name: null, phone: null },
  ];

  it('maps rows and asks PostgREST for the newest first', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify(rows), { status: 200 }));

    const store = createLeadStore(cfg);
    const leads = await store.getLeads({});

    expect(leads).toEqual([
      {
        createdAt: '2026-08-19T10:00:00Z',
        promoId: 'divany',
        promoTitle: 'Диваны',
        page: '/mebel',
        name: 'Пётр',
        phone: '+79781234567',
      },
      { createdAt: '2026-08-18T09:00:00Z', promoId: 'divany', promoTitle: '', page: '', name: '', phone: '' },
    ]);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('/rest/v1/promo_leads?');
    expect(url).toContain('order=created_at.desc');
    expect(url).toContain('limit=500');
  });

  it('applies the promo and period filters', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200 }));

    await createLeadStore(cfg).getLeads({
      promoId: 'divany kupit',
      from: '2026-08-01T00:00:00Z',
      to: '2026-09-01T00:00:00Z',
      limit: 10,
    });

    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('promo_id=eq.divany%20kupit');
    expect(url).toContain('created_at=gte.2026-08-01T00%3A00%3A00Z');
    expect(url).toContain('created_at=lt.2026-09-01T00%3A00%3A00Z');
    expect(url).toContain('limit=10');
  });

  it('clamps the limit to the documented ceiling', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('[]', { status: 200 }));

    await createLeadStore(cfg).getLeads({ limit: 999_999 });

    expect(String(fetchMock.mock.calls[0][0])).toContain(`limit=${LEADS_MAX_LIMIT}`);
  });

  it('throws on a failed read (the route turns it into 502)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
    await expect(createLeadStore(cfg).getLeads({})).rejects.toThrow(/HTTP 500/);
  });
});
