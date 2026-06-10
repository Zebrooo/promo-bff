import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Load .env (real S3 credentials + endpoint) so the suite runs against bucket.ru.
// process.loadEnvFile is built into Node 20.6+; ignore if .env is absent (e.g. CI).
try {
  process.loadEnvFile(fileURLToPath(new URL('./.env', import.meta.url)));
} catch {
  // no .env present — rely on the ambient environment
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
