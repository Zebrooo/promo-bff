import { S3Client } from '@aws-sdk/client-s3';
import { config } from '../config';

let client: S3Client | null = null;

/**
 * Lazily-constructed singleton S3 client. Targets the configured S3-compatible
 * endpoint (bucket.ru) with path-style addressing; creds come via the standard AWS
 * SDK chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).
 */
export function getS3Client(): S3Client {
  if (!client) {
    client = new S3Client({
      region: config.s3.region,
      ...(config.s3.endpoint ? { endpoint: config.s3.endpoint } : {}),
      forcePathStyle: config.s3.forcePathStyle,
    });
  }
  return client;
}

/** Pool object key (all promos), honouring the optional key prefix. */
export function promosKey(): string {
  return `${config.s3.keyPrefix}promos.json`;
}

/** Queue object key for a named queue, honouring the optional key prefix. */
export function queueKey(name: string): string {
  return `${config.s3.keyPrefix}queue-${name}.json`;
}

/** True when an S3 error means "the object does not exist yet". */
export function isNoSuchKey(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

/** Test seam: drop the memoized client so a fresh one is built next call. */
export function resetS3ClientForTests(): void {
  client = null;
}
