/**
 * Состояние модерации рекламных кампаний — JSON в S3 рядом с promos.json.
 *
 * Почему S3, а не колонка в ad_campaigns: схему таблицы ведёт витрина
 * (abkhaz-auto), миграций у BFF нет, а CHECK-ограничения на status нам не
 * видны — писать в неё новый статус «на модерации» вслепую нельзя. Решения
 * админов же — данные рекламной подсистемы, и промо-конфиг она уже держит
 * в этом бакете. Один объект, read-modify-write, last-write-wins (как и
 * промо-пул): пишет его ТОЛЬКО поллер/ручки модерации в одном процессе BFF.
 */
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../config';
import { campaignModerationKey, getS3Client, isNoSuchKey } from './s3-client';

export type ModerationDecision = 'pending' | 'approved' | 'rejected';

export interface ModerationEntry {
  decision: ModerationDecision;
  /** Когда BFF впервые увидел кампанию. */
  seenAt: string;
  decidedAt?: string;
  decidedBy?: string;
  reason?: string;
  /** Когда админам ушло уведомление о новой кампании. */
  notifiedAt?: string;
  /** Статус, который BFF успешно записал в БД витрины при решении (например,
   *  'paused' при отклонении). По нему поллер отличает «рекламодатель снова
   *  включил отклонённую кампанию» от «PATCH статуса не прошёл». */
  dbStatusAfterDecision?: string;
  /** Кампания была отклонена и включена рекламодателем заново — ушла на
   *  повторную модерацию в этот момент. */
  resubmittedAt?: string;
}

export interface ModerationState {
  version: 1;
  /** null = файла ещё не было: первый опрос считает ВСЕ существующие кампании
   *  одобренными (они запущены до появления модерации), чтобы включение
   *  фичи не погасило работающую рекламу. */
  bootstrappedAt: string | null;
  /** campaignId (строкой) → запись. */
  campaigns: Record<string, ModerationEntry>;
}

export interface ModerationStore {
  read(): Promise<ModerationState>;
  write(state: ModerationState): Promise<void>;
}

export function emptyModerationState(): ModerationState {
  return { version: 1, bootstrappedAt: null, campaigns: {} };
}

function normalize(raw: unknown): ModerationState {
  if (typeof raw !== 'object' || raw === null) return emptyModerationState();
  const r = raw as Record<string, unknown>;
  const campaigns: Record<string, ModerationEntry> = {};
  const rawCampaigns = r.campaigns;
  if (typeof rawCampaigns === 'object' && rawCampaigns !== null) {
    for (const [id, entry] of Object.entries(rawCampaigns as Record<string, unknown>)) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const decision = e.decision;
      if (decision !== 'pending' && decision !== 'approved' && decision !== 'rejected') continue;
      campaigns[id] = {
        decision,
        seenAt: typeof e.seenAt === 'string' ? e.seenAt : new Date(0).toISOString(),
        ...(typeof e.decidedAt === 'string' ? { decidedAt: e.decidedAt } : {}),
        ...(typeof e.decidedBy === 'string' ? { decidedBy: e.decidedBy } : {}),
        ...(typeof e.reason === 'string' ? { reason: e.reason } : {}),
        ...(typeof e.notifiedAt === 'string' ? { notifiedAt: e.notifiedAt } : {}),
        ...(typeof e.dbStatusAfterDecision === 'string' ? { dbStatusAfterDecision: e.dbStatusAfterDecision } : {}),
        ...(typeof e.resubmittedAt === 'string' ? { resubmittedAt: e.resubmittedAt } : {}),
      };
    }
  }
  return {
    version: 1,
    bootstrappedAt: typeof r.bootstrappedAt === 'string' ? r.bootstrappedAt : null,
    campaigns,
  };
}

export function createS3ModerationStore(): ModerationStore {
  return {
    async read() {
      try {
        const res = await getS3Client().send(
          new GetObjectCommand({ Bucket: config.s3.bucket, Key: campaignModerationKey() }),
        );
        if (!res.Body) return emptyModerationState();
        return normalize(JSON.parse(await res.Body.transformToString()));
      } catch (err) {
        if (isNoSuchKey(err)) return emptyModerationState();
        throw err;
      }
    },
    async write(state) {
      await getS3Client().send(
        new PutObjectCommand({
          Bucket: config.s3.bucket,
          Key: campaignModerationKey(),
          Body: JSON.stringify(state, null, 2),
          ContentType: 'application/json',
        }),
      );
    },
  };
}

/** Тестовый стор в памяти (ровно та же семантика «нет файла → пустое состояние»). */
export function createInMemoryModerationStore(initial?: ModerationState): ModerationStore & { state: ModerationState | null } {
  const box: { state: ModerationState | null } = { state: initial ?? null };
  return {
    get state() { return box.state; },
    set state(v) { box.state = v; },
    async read() { return box.state ? normalize(JSON.parse(JSON.stringify(box.state))) : emptyModerationState(); },
    async write(state) { box.state = JSON.parse(JSON.stringify(state)); },
  };
}
