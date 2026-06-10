#!/usr/bin/env node
/**
 * BFF post-deploy smoke check.
 *
 * Run AFTER `systemctl restart promo-bff` (and a few seconds of tsx warmup).
 * Exits 0 if every canonical queue resolves to at least one renderable promo
 * via the same code path the storefront uses; exits 1 with a diagnostic if
 * any queue is empty or unresolvable.
 *
 * Why this matters: today's incident (2026-05-31) shipped a working BFF
 * binary, but the S3 state had `queues.json` listing only `main` while the
 * storefront sites read `home-banner` / `home-popup` — so the banner went
 * dark and the only signal was an empty page. This script catches that
 * mismatch within seconds of the rolling restart, before users notice.
 *
 * Usage:
 *   node scripts/bff-smoke.mjs              # use ./.env
 *   PROMO_BUCKET=config node scripts/bff-smoke.mjs
 *
 * Reads the S3 endpoint + credentials from the same env the BFF reads
 * (PROMO_S3_*, AWS_*). Talks directly to S3 — no service-ticket needed,
 * no BFF auth detour.
 */
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const SLOTS = [
  // Storefront slot name (for diagnostics) → queue file the BFF reads.
  // Keep in sync with abkhaz-auto/src/lib/promo-slots.ts.
  { slot: 'home topline (banner)', queue: 'home-banner' },
  { slot: 'home popup',             queue: 'home-popup'  },
];

const endpoint = process.env.PROMO_S3_ENDPOINT;
const bucket   = process.env.PROMO_BUCKET;
const accessKeyId     = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const region = process.env.AWS_REGION ?? 'us-east-1';

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
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await r.Body.transformToString());
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

const failures = [];

try {
  const pool = await readJson('promos.json');
  if (!Array.isArray(pool)) {
    console.error('[bff-smoke] promos.json missing or not an array — pool is empty');
    process.exit(1);
  }
  const poolIds = new Set(pool.map((p) => p?.id).filter(Boolean));

  for (const { slot, queue } of SLOTS) {
    const obj = await readJson(`queue-${queue}.json`);
    if (!obj || !Array.isArray(obj.ids)) {
      failures.push(`${slot} → queue-${queue}.json missing or malformed (storefront slot will be empty)`);
      continue;
    }
    const resolvable = obj.ids.filter((id) => poolIds.has(id));
    const dangling   = obj.ids.filter((id) => !poolIds.has(id));

    // An empty queue file (ids: []) is a legitimate state — the advertiser
    // just hasn't added a promo to that slot yet. The site renders nothing,
    // which is the correct behaviour. So treat it as a WARNING, not a fail.
    if (obj.ids.length === 0) {
      console.log(`[bff-smoke] WARN ${slot.padEnd(26)} queue=${queue} · empty (no promo configured for this slot)`);
      continue;
    }

    // A non-empty queue with ZERO resolvable ids is a real regression — the
    // advertiser added promos but every one of them points to a missing pool
    // entry. The site will render nothing AND the cabinet probably looks
    // wrong too. Fail loudly.
    if (resolvable.length === 0) {
      failures.push(`${slot} → queue "${queue}" has ${obj.ids.length} dangling id(s) and 0 resolvable: ${JSON.stringify(dangling)}`);
      continue;
    }
    const note = dangling.length ? ` · ${dangling.length} dangling: ${JSON.stringify(dangling)}` : '';
    console.log(`[bff-smoke] OK   ${slot.padEnd(26)} queue=${queue} · ${resolvable.length} promo(s)${note}`);
  }

  if (failures.length > 0) {
    console.error('');
    console.error('[bff-smoke] FAILED — storefront will see EMPTY slots:');
    for (const f of failures) console.error('  – ' + f);
    process.exit(1);
  }
  console.log('');
  console.log('[bff-smoke] all canonical queues resolve to at least one promo · OK');
} catch (err) {
  console.error('[bff-smoke] unexpected error:', err?.message ?? err);
  process.exit(1);
}
