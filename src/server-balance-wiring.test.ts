// Regression coverage for a residual code-review finding: server.ts has TWO
// createBalanceService() call sites (SelectPromoDeps and auctionDeps — the
// latter is reused by feedFillDeps, see server.ts's comment there). Both must
// pass config.aaSupabase explicitly, because balance-service.ts always reads
// abkhaz-auto Supabase's ledger_accounts (its own doc comment says so) — the
// bare default (config.supabase) only happens to coincide with aaSupabase
// today because docker-compose pins PROMO_SUPABASE_URL to AA_SUPABASE_URL. A
// future infra split would silently read wallet balances from the wrong
// instance for whichever call site was left on the bare default.
//
// Isolated into its own file (rather than added to server.test.ts) so the
// vi.mock('./services/balance-service') below doesn't affect every other test
// in that much larger file.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { register as promRegister } from 'prom-client';

const createBalanceServiceMock = vi.hoisted(() =>
  vi.fn((_cfg?: unknown) => ({ getBalances: async () => new Map<string, number>() })),
);

vi.mock('./services/balance-service', () => ({
  createBalanceService: createBalanceServiceMock,
}));

import { buildServer } from './server';
import { config } from './config';

beforeEach(() => { promRegister.clear(); });
afterEach(() => { promRegister.clear(); });

describe('server.ts createBalanceService() wiring', () => {
  it('passes config.aaSupabase to BOTH call sites (SelectPromoDeps and auctionDeps)', () => {
    createBalanceServiceMock.mockClear();
    const app = buildServer({ logger: false });

    expect(createBalanceServiceMock).toHaveBeenCalledTimes(2);
    for (const call of createBalanceServiceMock.mock.calls) {
      expect(call[0]).toBe(config.aaSupabase);
      expect(call[0]).not.toBe(config.supabase);
    }

    return app.close();
  });
});
