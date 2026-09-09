/**
 * Хранилище пуш-кампаний — один JSON в S3 (push-campaigns.json, тот же бакет
 * и PROMO_KEY_PREFIX, что у promos.json). Формат файла:
 *   { version: 1, campaigns: PushCampaign[] }
 *
 * Read-modify-write целиком, last-write-wins — кампаний десятки, пишет только
 * BFF (кабинет ходит через его ручки), конкурентные записи сериализует
 * push-campaign-service.ts. Кривая запись пропускается с предупреждением,
 * чтобы одна битая кампания не прятала остальные (как parsePoolLeniently).
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';
import { getS3Client, isNoSuchKey, pushCampaignsKey } from './s3-client';
import { pushCampaignSchema, pushCampaignsFileSchema, type PushCampaign } from './push-campaign-schema';

export interface PushCampaignStore {
  read(): Promise<PushCampaign[]>;
  write(campaigns: PushCampaign[]): Promise<void>;
}

export interface StoreLogger {
  warn(obj: unknown, msg?: string): void;
}

export function parsePushCampaignsFile(raw: unknown, logger?: StoreLogger): PushCampaign[] {
  const file = pushCampaignsFileSchema.safeParse(raw);
  if (!file.success) {
    logger?.warn({ issues: file.error.issues }, 'push-campaign-store: push-campaigns.json has an unexpected shape — treating as empty');
    return [];
  }
  const out: PushCampaign[] = [];
  for (const item of file.data.campaigns) {
    const parsed = pushCampaignSchema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
    else logger?.warn({ id: (item as { id?: unknown } | null)?.id, issues: parsed.error.issues }, 'push-campaign-store: skipping invalid campaign');
  }
  return out;
}

export function createS3PushCampaignStore(logger?: StoreLogger): PushCampaignStore {
  return {
    async read() {
      let text: string;
      try {
        const res = await getS3Client().send(new GetObjectCommand({ Bucket: config.s3.bucket, Key: pushCampaignsKey() }));
        if (!res.Body) return [];
        text = await res.Body.transformToString();
      } catch (err) {
        if (isNoSuchKey(err)) return [];
        throw err;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(text);
      } catch {
        logger?.warn({}, 'push-campaign-store: push-campaigns.json is not valid JSON — treating as empty');
        return [];
      }
      return parsePushCampaignsFile(raw, logger);
    },
    async write(campaigns) {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: pushCampaignsKey(),
          Body: JSON.stringify({ version: 1, campaigns }, null, 2),
          ContentType: 'application/json',
        }),
      );
    },
  };
}

/** Тестовый стор в памяти (та же семантика «нет файла → пусто»). */
export function createInMemoryPushCampaignStore(initial: PushCampaign[] = []): PushCampaignStore & { campaigns: PushCampaign[] } {
  const box = { campaigns: JSON.parse(JSON.stringify(initial)) as PushCampaign[] };
  return {
    get campaigns() { return box.campaigns; },
    set campaigns(v) { box.campaigns = v; },
    async read() { return JSON.parse(JSON.stringify(box.campaigns)) as PushCampaign[]; },
    async write(campaigns) { box.campaigns = JSON.parse(JSON.stringify(campaigns)) as PushCampaign[]; },
  };
}
