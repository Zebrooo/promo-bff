#!/usr/bin/env node
/**
 * s3-snapshot.mjs — снапшот/восстановление промо-каталога в S3.
 *
 * Зачем: запись в бакет — безусловный PUT (last-write-wins, версионирования
 * нет). Перед ручными операциями шага B/D per-catalog миграции (см.
 * docs/2026-07-01-per-catalog-queues.md, SUPPLEMENT S-4) снапшот обязателен —
 * иначе ошибочная перекладка очередей необратима.
 *
 * Снимает: promos.json, queues.json и queue-<name>.json для КАЖДОЙ очереди
 * из индекса (не только прод-матрицы smoke) + queue-файлы, на которые индекс
 * не ссылается, не ищет (orphan-файлы вне индекса в снапшот не попадают).
 *
 * Использование (на сервере, из /data/promo-bff):
 *   node --env-file=.env scripts/s3-snapshot.mjs
 *     → backups/s3-snapshot-<UTC-timestamp>/ + manifest.json
 *   node --env-file=.env scripts/s3-snapshot.mjs --restore backups/s3-snapshot-<ts>
 *     → заливает ВСЕ файлы снапшота обратно (перезаписывает текущее состояние!)
 *
 * Env — те же, что у BFF/smoke: PROMO_S3_ENDPOINT, PROMO_BUCKET,
 * AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, [AWS_REGION], [PROMO_KEY_PREFIX].
 */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
const restoreIdx = args.indexOf('--restore');
const restoreDir = restoreIdx !== -1 ? args[restoreIdx + 1] : null;
if (restoreIdx !== -1 && !restoreDir) {
  console.error('[s3-snapshot] --restore требует путь к папке снапшота');
  process.exit(2);
}

const { S3Client, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');

const endpoint = process.env.PROMO_S3_ENDPOINT;
const bucket = process.env.PROMO_BUCKET;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const keyPrefix = process.env.PROMO_KEY_PREFIX ?? process.env.PROMO_S3_KEY_PREFIX ?? '';
if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
  console.error('[s3-snapshot] missing PROMO_S3_ENDPOINT / PROMO_BUCKET / AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY');
  process.exit(2);
}
const s3 = new S3Client({
  region: process.env.AWS_REGION ?? 'us-east-1',
  endpoint,
  forcePathStyle: process.env.PROMO_S3_FORCE_PATH_STYLE !== 'false',
  credentials: { accessKeyId, secretAccessKey },
});

async function readText(key) {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${keyPrefix}${key}` }));
    return await r.Body.transformToString();
  } catch (err) {
    if (err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) return null;
    throw err;
  }
}

if (restoreDir) {
  // ---- restore: залить все *.json из папки снапшота (кроме manifest) ----
  const files = (await readdir(restoreDir)).filter((f) => f.endsWith('.json') && f !== 'manifest.json');
  if (!files.length) {
    console.error(`[s3-snapshot] в ${restoreDir} нет json-файлов`);
    process.exit(2);
  }
  console.log(`[s3-snapshot] RESTORE ${files.length} объектов из ${restoreDir} → bucket "${bucket}" (last-write-wins, текущее состояние будет перезаписано)`);
  for (const f of files) {
    const body = await readFile(path.join(restoreDir, f), 'utf8');
    JSON.parse(body); // валидация перед заливкой
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: `${keyPrefix}${f}`, Body: body, ContentType: 'application/json' }));
    console.log(`[s3-snapshot]   put ${keyPrefix}${f} (${body.length} bytes)`);
  }
  console.log('[s3-snapshot] restore done — проверь смоуком: node --env-file=.env scripts/bff-smoke.mjs');
  process.exit(0);
}

// ---- snapshot ----
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19); // UTC
const dir = path.join('backups', `s3-snapshot-${stamp}`);
await mkdir(dir, { recursive: true });

const saved = [];
async function save(key) {
  const text = await readText(key);
  if (text === null) {
    console.log(`[s3-snapshot]   skip ${key} — отсутствует в бакете`);
    return null;
  }
  await writeFile(path.join(dir, key), text);
  saved.push({ key, bytes: text.length });
  console.log(`[s3-snapshot]   saved ${key} (${text.length} bytes)`);
  return text;
}

console.log(`[s3-snapshot] bucket "${bucket}" prefix "${keyPrefix}" → ${dir}`);
await save('promos.json');
const queuesText = await save('queues.json');
const index = queuesText ? JSON.parse(queuesText) : [];
const names = (Array.isArray(index) ? index : []).map((e) => e?.name).filter(Boolean);
for (const name of names) await save(`queue-${name}.json`);

await writeFile(
  path.join(dir, 'manifest.json'),
  JSON.stringify({ takenAt: new Date().toISOString(), bucket, keyPrefix, queues: names, files: saved }, null, 2)
);
console.log(`[s3-snapshot] done — ${saved.length} объектов (${names.length} очередей).`);
console.log(`[s3-snapshot] restore: node --env-file=.env scripts/s3-snapshot.mjs --restore ${dir}`);
