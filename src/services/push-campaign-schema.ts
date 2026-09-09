/**
 * Пуш-кампании промо-кабинета (раздел «Push-рассылки»): контракт хранения и
 * входа. Кабинет присылает черновик (title/body/url/icon + таргетинг), BFF
 * хранит его в S3 (push-campaigns.json) и по команде «Отправить» шлёт FCM-пуш
 * через витрину (abkhaz-auto POST /api/v1/push/broadcast).
 *
 * Таргетинг — те же оси, что у промо (targeting/audience/sellerStatus/
 * sections/categories/schedule/lifecycle), и та же схема (promoSchema из
 * catalogue-schema.ts) — чтобы кабинет мог переиспользовать свою форму
 * фильтров. На первом этапе таргетинг ТОЛЬКО сохраняется: рассылка уходит
 * всем пользователям с FCM-токенами (см. push-campaign-service.ts).
 */
import { z } from 'zod';
import { audienceSchema, lifecycleTargetingSchema, promoTargetingSchema, scheduleSchema } from './catalogue-schema';

/** Схема «javascript:»/«data:» в ссылке пуша — XSS в чужом документе. */
const DANGEROUS_SCHEME = /^[\s\u0000-\u001f]*(javascript|data|vbscript|file):/i;
/** Относительный путь витрины (/listing/123) или http(s)-URL. */
const URL_SHAPE = /^(\/(?!\/)|https?:\/\/)/i;

export const pushCampaignStatusSchema = z.enum(['draft', 'sent']);
export type PushCampaignStatus = z.infer<typeof pushCampaignStatusSchema>;

/** Общие с промо оси таргетинга — байт-в-байт promoSchema (без format/дат). */
export const pushTargetingShape = {
  targeting: promoTargetingSchema,
  audience: audienceSchema.optional(),
  sellerStatus: z.enum(['seller', 'buyer']).optional(),
  sections: z.array(z.string().min(1)).optional(),
  categories: z.array(z.string().min(1)).optional(),
  schedule: scheduleSchema.optional(),
  lifecycle: lifecycleTargetingSchema.optional(),
};

/** Что кабинет присылает в POST /push-campaigns. id — только для обновления
 *  существующего черновика; без него BFF создаёт новую кампанию. */
export const pushCampaignInputSchema = z.object({
  id: z.string().min(1).max(64).regex(/^[a-z0-9_-]+$/i).optional(),
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(600),
  url: z.string().trim().min(1).max(1024)
    .refine((v) => !DANGEROUS_SCHEME.test(v), 'url scheme is not allowed')
    .refine((v) => URL_SHAPE.test(v), 'url must be an absolute path or http(s) URL'),
  icon: z.string().trim().url().max(1024).refine((v) => /^https?:\/\//i.test(v), 'icon must be http(s)').optional(),
  ...pushTargetingShape,
});
export type PushCampaignInput = z.infer<typeof pushCampaignInputSchema>;

/** Итог рассылки — как его отдаёт витрина (/api/v1/push/broadcast). */
export const pushSendResultSchema = z.object({
  /** Сколько пользователей попало в рассылку (с хотя бы одним токеном). */
  users: z.number().int().nonnegative(),
  /** Сколько токенов/устройств пытались, доставили, не смогли. */
  attempted: z.number().int().nonnegative(),
  delivered: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
});
export type PushSendResult = z.infer<typeof pushSendResultSchema>;

/** Запись в push-campaigns.json. */
export const pushCampaignSchema = pushCampaignInputSchema.extend({
  id: z.string().min(1).max(64),
  status: pushCampaignStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().optional(),
  sendResult: pushSendResultSchema.optional(),
  /** Текст последней неудачной попытки отправки (черновик остаётся черновиком). */
  lastSendError: z.string().max(500).optional(),
});
export type PushCampaign = z.infer<typeof pushCampaignSchema>;

export const pushCampaignsFileSchema = z.object({
  version: z.literal(1),
  campaigns: z.array(z.unknown()),
});
