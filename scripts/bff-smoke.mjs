#!/usr/bin/env node
/**
 * BFF post-deploy smoke check — queue × format matrix.
 *
 * Run AFTER `systemctl restart promo-bff` (and a few seconds of tsx warmup).
 * For every production queue it verifies, via the same S3 objects the BFF
 * reads, that:
 *
 *   1. the queue is REGISTERED in queues.json (the cabinet index) — the
 *      2026-05-31 incident shipped an index listing only `main` while the
 *      storefront read `home-banner`/`home-popup`, darking the slots;
 *   2. queue-<name>.json is READABLE — a missing object is reported as
 *      "missing" (deploy/state regression), distinctly from "empty"
 *      (ids: [], a legitimate "no promo configured yet" state);
 *   3. for each required format there is ≥1 ACTIVE promo of that format in
 *      the queue (format + show window read from promos.json). A queue with
 *      promos but ZERO active ones across all its required formats FAILS —
 *      the slot is dark while the cabinet looks populated.
 *
 * Severity: an empty queue and per-format gaps are WARN by default; pass
 * `--strict-empty` to turn an EMPTY queue into a failure (e.g. in CI for a
 * fully-provisioned prod). Structural problems (unregistered queue, missing
 * or malformed queue object, all-dangling ids, zero active promos) always FAIL.
 *
 * Usage:
 *   node scripts/bff-smoke.mjs                 # live check against S3 (env below)
 *   node scripts/bff-smoke.mjs --strict-empty  # empty queue = failure
 *   node scripts/bff-smoke.mjs --dry-run       # self-test on built-in fixtures, no S3/creds
 *
 * Live mode reads the S3 endpoint + credentials from the same env the BFF
 * reads (PROMO_S3_*, PROMO_BUCKET, AWS_*). Talks directly to S3 — no
 * service-ticket needed, no BFF auth detour.
 */

/**
 * Production queue matrix: which queues must exist and which creative formats
 * each one must be able to serve. `requiredFormats` mirrors the `formats`
 * param the consumer sends to the BFF for that slot.
 * Keep in sync with abkhaz-auto's promo-slots wiring + the ad-cabinet's
 * PROD_SERVED_QUEUES (src/lib/catalogue.ts).
 */
const PROD_QUEUES = [
  { queue: 'home-banner',        requiredFormats: ['topline'] },
  { queue: 'home-popup',         requiredFormats: ['popup', 'fullscreen', 'inline', 'divkit'] },
  { queue: 'tooltip',            requiredFormats: ['tooltip'] },
  { queue: 'cabinet-onboarding', requiredFormats: ['tooltip'] },
  // Per-catalog queues (step C of docs/2026-07-01-per-catalog-queues.md).
  // Uncomment when the storefront cuts over to per-catalog queues; each queue
  // serves both the topline surface and the overlay surface of its catalog:
  // { queue: 'home',      requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
  // { queue: 'transport', requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
  // { queue: 'realty',    requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
  // { queue: 'goods',     requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
  // { queue: 'services',  requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
  // { queue: 'jobs',      requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
  // { queue: 'news',      requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
  // { queue: 'listing',   requiredFormats: ['topline', 'popup', 'fullscreen', 'inline', 'divkit'] },
];

// ---------------------------------------------------------------------------
// Pure check core (also exercised by --dry-run; no I/O in here).
// ---------------------------------------------------------------------------

/** A promo is active when `now` falls inside its show window (missing bound = open). */
function isActive(promo, now) {
  const starts = promo?.startsAt ? Date.parse(promo.startsAt) : NaN;
  const ends = promo?.endsAt ? Date.parse(promo.endsAt) : NaN;
  if (!Number.isNaN(starts) && now < starts) return false;
  if (!Number.isNaN(ends) && now > ends) return false;
  return true;
}

/**
 * Runs the whole matrix against pre-read state.
 * @param state  { pool: unknown, queuesIndex: unknown, queueObjects: Record<name, unknown|null> }
 * @param matrix PROD_QUEUES-shaped array
 * @param opts   { strictEmpty: boolean, now: number (epoch ms) }
 * @returns      { lines: string[], warnings: string[], failures: string[] }
 */
function checkQueues(state, matrix, { strictEmpty, now }) {
  const lines = [];
  const warnings = [];
  const failures = [];

  const pool = Array.isArray(state.pool) ? state.pool : null;
  if (pool === null) {
    failures.push('promos.json missing or not an array — the pool is empty, every slot is dark');
    return { lines, warnings, failures };
  }
  const byId = new Map(pool.filter((p) => p && typeof p.id === 'string').map((p) => [p.id, p]));

  const index = Array.isArray(state.queuesIndex) ? state.queuesIndex : null;
  if (index === null) {
    failures.push('queues.json missing or not an array — no queue is registered (2026-05-31 incident mechanics)');
  }
  const registered = new Set((index ?? []).map((q) => q?.name).filter(Boolean));

  for (const { queue, requiredFormats } of matrix) {
    if (index !== null && !registered.has(queue)) {
      failures.push(`queue "${queue}" is not registered in queues.json — the cabinet cannot see it`);
    }

    const obj = state.queueObjects[queue] ?? null;
    if (obj === null) {
      failures.push(`queue-${queue}.json is MISSING (not the same as empty — the object was never written or was deleted)`);
      continue;
    }
    if (!Array.isArray(obj.ids)) {
      failures.push(`queue-${queue}.json is malformed (no ids array)`);
      continue;
    }

    if (obj.ids.length === 0) {
      const msg = `queue "${queue}" is EMPTY (ids: []) — no promo configured for this slot`;
      if (strictEmpty) failures.push(msg + ' [--strict-empty]');
      else warnings.push(msg);
      continue;
    }

    const resolved = obj.ids.map((id) => byId.get(id)).filter((p) => p !== undefined);
    const dangling = obj.ids.filter((id) => !byId.has(id));
    if (resolved.length === 0) {
      failures.push(`queue "${queue}" has ${obj.ids.length} dangling id(s) and 0 resolvable: ${JSON.stringify(dangling)}`);
      continue;
    }

    // Per-format coverage: ≥1 ACTIVE promo per required format.
    const active = resolved.filter((p) => isActive(p, now));
    const countByFormat = new Map(requiredFormats.map((f) => [f, 0]));
    for (const p of active) {
      if (countByFormat.has(p.format)) countByFormat.set(p.format, countByFormat.get(p.format) + 1);
    }
    const uncovered = requiredFormats.filter((f) => countByFormat.get(f) === 0);

    if (uncovered.length === requiredFormats.length) {
      failures.push(
        `queue "${queue}" has ${resolved.length} promo(s) but 0 ACTIVE for any required format ` +
          `(${requiredFormats.join('/')}) — slot is dark while the cabinet looks populated`,
      );
      continue;
    }

    if (uncovered.length > 0) {
      warnings.push(`queue "${queue}": no active promo for format(s) ${uncovered.join(', ')} — those surfaces stay empty`);
    }

    const fmtSummary = requiredFormats.map((f) => `${f}=${countByFormat.get(f)}`).join(' ');
    const notes = dangling.length > 0 ? ` · ${dangling.length} dangling: ${JSON.stringify(dangling)}` : '';
    lines.push(`OK   ${queue.padEnd(20)} active=${active.length}/${resolved.length} · ${fmtSummary}${notes}`);
  }

  return { lines, warnings, failures };
}

// ---------------------------------------------------------------------------
// --dry-run: self-test the check core on built-in fixtures (no S3, no creds).
// ---------------------------------------------------------------------------

function runSelfTest() {
  const now = Date.parse('2026-07-02T12:00:00.000Z');
  const win = { startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2100-01-01T00:00:00.000Z' };
  const fixtures = {
    pool: [
      { id: 't1', format: 'topline', ...win },
      { id: 'p1', format: 'popup', ...win },
      { id: 'p-old', format: 'popup', startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2021-01-01T00:00:00.000Z' },
      { id: 'tt1', format: 'tooltip', ...win },
    ],
    // cabinet-onboarding deliberately unregistered AND its object missing.
    queuesIndex: [{ name: 'home-banner' }, { name: 'home-popup' }, { name: 'tooltip' }, { name: 'dead-queue' }],
    queueObjects: {
      'home-banner': { persist: true, ids: ['t1', 'ghost'] }, // OK + 1 dangling
      'home-popup': { persist: false, ids: ['p-old'] },       // non-empty but 0 active → FAIL
      tooltip: { persist: false, ids: [] },                   // empty → WARN (FAIL with --strict-empty)
      // 'cabinet-onboarding' object intentionally absent      → MISSING → FAIL
    },
  };

  const assert = (cond, label) => {
    if (!cond) {
      console.error(`[bff-smoke:dry-run] SELF-TEST FAILED: ${label}`);
      process.exit(1);
    }
    console.log(`[bff-smoke:dry-run] ok — ${label}`);
  };

  const res = checkQueues(fixtures, PROD_QUEUES, { strictEmpty: false, now });
  assert(res.lines.some((l) => l.includes('home-banner') && l.includes('topline=1')), 'home-banner passes with topline=1');
  assert(res.lines.some((l) => l.includes('1 dangling')), 'dangling id is reported on an OK queue');
  assert(res.failures.some((f) => f.includes('home-popup') && f.includes('0 ACTIVE')), 'expired-only queue fails (0 active)');
  assert(res.warnings.some((w) => w.includes('"tooltip"') && w.includes('EMPTY')), 'empty queue warns by default');
  assert(!res.failures.some((f) => f.includes('"tooltip"')), 'empty queue is not a failure by default');
  assert(res.failures.some((f) => f.includes('cabinet-onboarding') && f.includes('not registered')), 'unregistered queue fails');
  assert(res.failures.some((f) => f.includes('queue-cabinet-onboarding.json is MISSING')), 'missing queue object fails distinctly from empty');

  const strict = checkQueues(fixtures, PROD_QUEUES, { strictEmpty: true, now });
  assert(strict.failures.some((f) => f.includes('"tooltip"') && f.includes('EMPTY')), '--strict-empty turns the empty queue into a failure');

  const noIndex = checkQueues({ ...fixtures, queuesIndex: null }, PROD_QUEUES, { strictEmpty: false, now });
  assert(noIndex.failures.some((f) => f.includes('queues.json missing')), 'missing queues.json index fails');

  const noPool = checkQueues({ ...fixtures, pool: null }, PROD_QUEUES, { strictEmpty: false, now });
  assert(noPool.failures.some((f) => f.includes('promos.json missing')), 'missing pool fails');

  console.log('');
  console.log('[bff-smoke:dry-run] self-test passed — check core behaves as specified');
}

// ---------------------------------------------------------------------------
// Live mode: read S3 state and run the matrix.
// ---------------------------------------------------------------------------

async function runLive({ strictEmpty }) {
  const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');

  const endpoint = process.env.PROMO_S3_ENDPOINT;
  const bucket = process.env.PROMO_BUCKET;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const region = process.env.AWS_REGION ?? 'us-east-1';
  const keyPrefix = process.env.PROMO_S3_KEY_PREFIX ?? '';

  if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
    console.error('[bff-smoke] missing PROMO_S3_ENDPOINT / PROMO_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
    process.exit(2);
  }

  const s3 = new S3Client({
    region,
    endpoint,
    forcePathStyle: process.env.PROMO_S3_FORCE_PATH_STYLE !== 'false',
    credentials: { accessKeyId, secretAccessKey },
  });

  /** Read a JSON object from the bucket. Missing → null. */
  async function readJson(key) {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${keyPrefix}${key}` }));
      return JSON.parse(await r.Body.transformToString());
    } catch (err) {
      if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  const [pool, queuesIndex] = await Promise.all([readJson('promos.json'), readJson('queues.json')]);
  const queueObjects = {};
  for (const { queue } of PROD_QUEUES) {
    queueObjects[queue] = await readJson(`queue-${queue}.json`);
  }

  const { lines, warnings, failures } = checkQueues(
    { pool, queuesIndex, queueObjects },
    PROD_QUEUES,
    { strictEmpty, now: Date.now() },
  );

  for (const l of lines) console.log(`[bff-smoke] ${l}`);
  for (const w of warnings) console.log(`[bff-smoke] WARN ${w}`);
  if (failures.length > 0) {
    console.error('');
    console.error('[bff-smoke] FAILED — storefront will see EMPTY slots:');
    for (const f of failures) console.error('  – ' + f);
    process.exit(1);
  }
  console.log('');
  console.log('[bff-smoke] all production queues serve their required formats · OK');
}

// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const strictEmpty = args.includes('--strict-empty');

try {
  if (args.includes('--dry-run')) {
    runSelfTest();
  } else {
    await runLive({ strictEmpty });
  }
} catch (err) {
  console.error('[bff-smoke] unexpected error:', err?.message ?? err);
  process.exit(1);
}
