/**
 * Seeds promos.json, queue-main.json and queues.json into the configured S3 bucket so there is
 * data once a bucket exists. Run manually: `npx tsx scripts/seed-catalogue.ts`. Requires
 * PROMO_BUCKET, AWS_REGION (+ optional PROMO_KEY_PREFIX) and AWS creds in the environment.
 */
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { config } from '../src/config';
import { promosKey, queueKey, getS3Client } from '../src/services/s3-client';
import { catalogueSchema } from '../src/services/catalogue-schema';
import type { Promo } from '../src/promo-selector/types';

const seed: Promo[] = [
  {
    id: 'premium-deal',
    name: 'Premium Members Deal',
    startsAt: '2020-01-01T00:00:00.000Z',
    endsAt: '2100-01-01T00:00:00.000Z',
    targeting: { subscriptionLevels: ['premium'] },
    cooldownHours: 0,
    format: 'fullscreen',
    title: 'Эксклюзив для Premium',
    description: 'Специальные условия для подписчиков Premium.',
    imageUrl: 'https://cdn.example.com/promo/premium-deal.png',
    action: { href: '/premium/deal' },
    dismissible: true,
  },
  {
    id: 'summer-sale',
    name: 'Summer Sale -30%',
    startsAt: '2020-01-01T00:00:00.000Z',
    endsAt: '2100-01-01T00:00:00.000Z',
    targeting: { minAge: 18, regions: ['ru', 'by'], subscriptionLevels: ['plus', 'premium'] },
    cooldownHours: 24,
    format: 'popup',
    title: 'Летняя распродажа −30%',
    description: 'Скидки до 30% на весь каталог до конца лета.',
    imageUrl: 'https://cdn.example.com/promo/summer-sale.png',
    action: { href: '/sale/summer', label: 'Подробнее' },
    dismissible: true,
  },
  {
    id: 'newcomer-bonus',
    name: 'Newcomer Bonus',
    startsAt: '2020-01-01T00:00:00.000Z',
    endsAt: '2100-01-01T00:00:00.000Z',
    targeting: { minAge: 18 },
    cooldownHours: 0,
    format: 'inline',
    title: 'Бонус новичку',
    description: 'Заберите приветственный бонус за первый визит.',
    action: { href: '/welcome', label: 'Забрать' },
  },
];

async function main(): Promise<void> {
  if (!config.s3.bucket) throw new Error('PROMO_BUCKET is not set');
  const promos = catalogueSchema.parse(seed); // fail fast if the seed is malformed
  const client = getS3Client();
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: promosKey(),
    Body: JSON.stringify(promos, null, 2), ContentType: 'application/json',
  }));
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: queueKey('main'),
    Body: JSON.stringify({ persist: false, ids: promos.map((p) => p.id) }, null, 2),
    ContentType: 'application/json',
  }));
  await client.send(new PutObjectCommand({
    Bucket: config.s3.bucket, Key: `${config.s3.keyPrefix}queues.json`,
    Body: JSON.stringify([{ name: 'main', persist: false }], null, 2),
    ContentType: 'application/json',
  }));
  console.log(`Seeded ${promos.length} promos to s3://${config.s3.bucket}/${promosKey()}, queue ${queueKey('main')}, and queues.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
