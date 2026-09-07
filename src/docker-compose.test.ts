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

  it('forwards the optional OpenRouter-only proxy without configuring a global proxy', () => {
    expect(compose).toMatch(
      /^      OPENROUTER_PROXY:\s*"\$\{OPENROUTER_PROXY:-\}"$/m,
    );
    expect(compose).not.toMatch(/^      HTTPS?_PROXY:/m);
  });

  it('runs push delivery as a private worker and mounts FCM credentials only there', () => {
    expect(compose).toMatch(/^  promo-push-worker:$/m);
    expect(compose).toMatch(/command: \["node", "--import", "tsx", "src\/push-worker\.ts"\]/);
    const apiBlock = compose.slice(compose.indexOf('  promo-bff:'), compose.indexOf('  promo-push-worker:'));
    const workerBlock = compose.slice(compose.indexOf('  promo-push-worker:'), compose.indexOf('\nnetworks:'));
    expect(apiBlock).not.toContain('fcm_service_account');
    expect(workerBlock).toContain('FCM_SERVICE_ACCOUNT_FILE: /run/secrets/fcm_service_account');
    expect(workerBlock).toContain('PUSH_WORKER_ENABLED: "${PUSH_WORKER_ENABLED:-false}"');
    expect(workerBlock).toContain(
      'PUSH_CAMPAIGN_LEASE_SECONDS: "${PUSH_CAMPAIGN_LEASE_SECONDS:-180}"',
    );
    expect(workerBlock).toContain('FCM_PROJECT_ID: "${FCM_PROJECT_ID:-}"');
    expect(workerBlock).toContain('- fcm_service_account');
    expect(workerBlock).not.toMatch(/^    ports:/m);
    expect(workerBlock).toContain('traefik.enable=false');
    expect(compose).toContain('file: "${FCM_SERVICE_ACCOUNT_FILE:-/dev/null}"');
  });
});
