import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const compose = readFileSync(
  fileURLToPath(new URL('../docker-compose.yml', import.meta.url)),
  'utf8',
);

describe('production docker compose', () => {
  it('routes promo storage to the AA production Supabase and requires both credentials', () => {
    expect(compose).toMatch(
      /^      PROMO_SUPABASE_URL:\s*"\$\{AA_SUPABASE_URL:\?[^}]+\}"$/m,
    );
    expect(compose).toMatch(
      /^      PROMO_SUPABASE_SERVICE_ROLE_KEY:\s*"\$\{AA_SUPABASE_SERVICE_ROLE_KEY:\?[^}]+\}"$/m,
    );
  });
});
