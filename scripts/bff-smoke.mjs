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
 *      the slot is dark while the cabinet looks populated. A queue declared
 *      with `requiredFormats: []` is checked for structure only (1 and 2):
 *      the format set belongs to the caller's route params, not to this file.
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
const CATALOGS = ['home', 'transport', 'realty', 'goods', 'services', 'jobs', 'news', 'listing'];
const DEVICES = ['web', 'touch', 'mobile'];

const PROD_QUEUES = [
  // Fixed-name slots the storefront requests by literal name.
  { queue: 'persistent-topline', requiredFormats: ['topline'] }, // fp/topline/route.ts
  { queue: 'persistent-inline',  requiredFormats: ['inline'] },  // fp/inline/route.ts
  { queue: 'tooltip',            requiredFormats: ['tooltip'] }, // fp/tooltip/route.ts
  { queue: 'cabinet-onboarding', requiredFormats: ['tooltip'] }, // fp/onboarding/route.ts

  // Per-device queues — the ONLY queues the catalog surfaces read. Both
  // fp/o/route.ts (overlay) and fp/promoline/route.ts (feed row) build the
  // name as `${catalogFromPath(path)}-${device}`, device = web|touch|mobile.
  //
  // requiredFormats is deliberately EMPTY: which formats each surface asks for
  // is decided by abkhaz-auto's route params, not here, and guessing would turn
  // this smoke into noise. Empty = structure only — the queue must be
  // registered, readable and not all-dangling. That is exactly the class of
  // failure that kept the promoline row invisible: the cabinet showed a
  // populated queue while the storefront read a different name.
  ...CATALOGS.flatMap((c) => DEVICES.map((d) => ({ queue: `${c}-${d}`, requiredFormats: [] }))),

  // home-banner / home-popup removed 2026-09-10. Audit of abkhaz-auto src/
  // confirmed neither name reaches the BFF: they were orphaned in 50271b2
  // (#77, "Overlay + topline no longer pin home-popup/home-banner") and today
  // survive only as cabinet slot ids (column campaign.slot), never as a queue.
  // The bare catalog names (home, transport, ...) were orphaned in d5e4520
  // (#113) by the per-device cutover and are covered above with a suffix.
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

    const active = resolved.filter((p) => isActive(p, now));

    // Structure-only queue (requiredFormats: []): the caller does not pin the
    // format set, so coverage is not checked. Everything above still applies —
    // registered, readable, resolvable ids.
    if (requiredFormats.length === 0) {
      const danglingNote = dangling.length > 0 ? ` \u00b7 ${dangling.length} dangling: ${JSON.stringify(dangling)}` : '';
      lines.push(`OK   ${queue.padEnd(20)} active=${active.length}/${resolved.length}${danglingNote}`);
      continue;
    }

    // Per-format coverage: \u22651 ACTIVE promo per required format.
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
    queuesIndex: [
      { name: 'persistent-topline' }, { name: 'persistent-inline' },
      { name: 'tooltip' }, { name: 'transport-web' }, { name: 'dead-queue' },
    ],
    queueObjects: {
      'persistent-topline': { persist: true, ids: ['t1', 'ghost'] }, // OK + 1 dangling
      'persistent-inline': { persist: false, ids: ['p-old'] },       // non-empty but 0 active → FAIL
      tooltip: { persist: false, ids: [] },                          // empty → WARN (FAIL with --strict-empty)
      'transport-web': { persist: false, ids: ['p1'] },              // structure-only → OK, no format check
      // 'cabinet-onboarding' object intentionally absent             → MISSING → FAIL
    },
  };

  // The self-test pins its own matrix: it exercises the check core, and must not
  // start failing every time the prod queue list is edited.
  const SELF_TEST_QUEUES = [
    { queue: 'persistent-topline', requiredFormats: ['topline'] },
    { queue: 'persistent-inline',  requiredFormats: ['inline'] },
    { queue: 'tooltip',            requiredFormats: ['tooltip'] },
    { queue: 'cabinet-onboarding', requiredFormats: ['tooltip'] },
    { queue: 'transport-web',      requiredFormats: [] },
  ];

  const assert = (cond, label) => {
    if (!cond) {
      console.error(`[bff-smoke:dry-run] SELF-TEST FAILED: ${label}`);
      process.exit(1);
    }
    console.log(`[bff-smoke:dry-run] ok — ${label}`);
  };

  const res = checkQueues(fixtures, SELF_TEST_QUEUES, { strictEmpty: false, now });
  assert(res.lines.some((l) => l.includes('persistent-topline') && l.includes('topline=1')), 'persistent-topline passes with topline=1');
  assert(res.lines.some((l) => l.includes('1 dangling')), 'dangling id is reported on an OK queue');
  assert(res.failures.some((f) => f.includes('persistent-inline') && f.includes('0 ACTIVE')), 'expired-only queue fails (0 active)');
  assert(res.lines.some((l) => l.includes('transport-web') && l.includes('active=1/1')), 'structure-only queue passes without a format check');
  assert(
    res.lines.find((l) => l.includes('transport-web'))?.includes('popup=') === false,
    'structure-only queue prints no per-format summary',
  );
  assert(!res.failures.some((f) => f.includes('transport-web')), 'structure-only queue with an off-list format is not a failure');
  assert(res.warnings.some((w) => w.includes('"tooltip"') && w.includes('EMPTY')), 'empty queue warns by default');
  assert(!res.failures.some((f) => f.includes('"tooltip"')), 'empty queue is not a failure by default');
  assert(res.failures.some((f) => f.includes('cabinet-onboarding') && f.includes('not registered')), 'unregistered queue fails');
  assert(res.failures.some((f) => f.includes('queue-cabinet-onboarding.json is MISSING')), 'missing queue object fails distinctly from empty');

  const strict = checkQueues(fixtures, SELF_TEST_QUEUES, { strictEmpty: true, now });
  assert(strict.failures.some((f) => f.includes('"tooltip"') && f.includes('EMPTY')), '--strict-empty turns the empty queue into a failure');

  const noIndex = checkQueues({ ...fixtures, queuesIndex: null }, SELF_TEST_QUEUES, { strictEmpty: false, now });
  assert(noIndex.failures.some((f) => f.includes('queues.json missing')), 'missing queues.json index fails');

  const noPool = checkQueues({ ...fixtures, pool: null }, SELF_TEST_QUEUES, { strictEmpty: false, now });
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
  // same env var the BFF itself reads (src/config.ts); legacy PROMO_S3_KEY_PREFIX kept as fallback
  const keyPrefix = process.env.PROMO_KEY_PREFIX ?? process.env.PROMO_S3_KEY_PREFIX ?? '';

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
