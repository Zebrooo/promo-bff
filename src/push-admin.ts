import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Authenticator } from './auth';
import {
  PushStoreError,
  type PushCampaignStore,
} from './services/push-campaign-store';

export type PushAdminEnv = 'test' | 'prod';

const envSchema = z.enum(['test', 'prod']);
const idSchema = z.string().uuid();
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/i);
const WORKER_HEALTH_MAX_AGE_MS = 30_000;

const listSchema = z
  .object({ env: envSchema, limit: z.number().int().min(1).max(100).optional() })
  .strict();
const getSchema = z.object({ env: envSchema, id: idSchema }).strict();
const upsertSchema = z
  .object({
    env: envSchema,
    commandId: z.string().uuid(),
    id: idSchema.optional(),
    expectedRevision: z.number().int().min(0).optional(),
    dedupKey: z
      .string()
      .trim()
      .min(3)
      .max(128)
      .regex(/^[a-z0-9][a-z0-9._:-]*$/),
    title: z.string().trim().min(1).max(120),
    body: z.string().trim().min(1).max(500),
    path: z
      .string()
      .trim()
      .min(1)
      .max(1024)
      .refine((value) => value.startsWith('/') && !value.startsWith('//') && !/[\u0000-\u001f]/.test(value)),
    audienceMode: z.enum(['marketing_opt_in', 'offline_consent']),
    consentBasis: z.string().trim().min(3).max(500).nullable().optional(),
    scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
    maxRecipients: z.number().int().min(1).max(500_000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.id && value.expectedRevision === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedRevision'],
        message: 'expectedRevision is required when editing a campaign',
      });
    }
    if (!value.id && value.expectedRevision !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['expectedRevision'],
        message: 'expectedRevision is only allowed when editing a campaign',
      });
    }
    if (value.audienceMode === 'offline_consent' && !value.consentBasis) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consentBasis'],
        message: 'consentBasis is required for offline_consent',
      });
    }
    if (value.audienceMode === 'marketing_opt_in' && value.consentBasis) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['consentBasis'],
        message: 'consentBasis is only allowed for offline_consent',
      });
    }
  });
const actionSchema = z
  .object({
    env: envSchema,
    id: idSchema,
    expectedRevision: z.number().int().min(0),
    commandId: z.string().uuid(),
  })
  .strict();
const queueSchema = z
  .object({
    env: envSchema,
    id: idSchema,
    expectedRevision: z.number().int().min(0),
    commandId: z.string().uuid(),
    expectedEligibleUsers: z.number().int().min(0).max(500_000),
    expectedAudienceDigest: digestSchema,
    expectedPayloadHash: digestSchema,
    confirmation: z.string().regex(/^(0|[1-9][0-9]{0,7})$/),
    maxRecipients: z.number().int().min(1).max(500_000),
  })
  .strict();

function invalidBody(reply: FastifyReply, error: z.ZodError): FastifyReply {
  const first = error.issues[0];
  const field = first?.path.length ? first.path.join('.') : 'body';
  return reply.code(400).send({ error: 'bad_request', message: `Invalid ${field}` });
}

function storeFor(
  stores: Record<PushAdminEnv, PushCampaignStore>,
  env: PushAdminEnv,
  reply: FastifyReply,
): PushCampaignStore | null {
  const store = stores[env];
  if (!store.configured) {
    reply.code(503).send({ error: 'env_not_configured' });
    return null;
  }
  return store;
}

function sendStoreError(reply: FastifyReply, error: unknown): FastifyReply {
  if (!(error instanceof PushStoreError)) {
    return reply.code(502).send({ error: 'push_admin_unavailable' });
  }
  switch (error.code) {
    case 'not_found':
      return reply.code(404).send({ error: 'campaign_not_found' });
    case 'invalid_state':
      return reply.code(409).send({ error: 'invalid_state', message: error.message });
    case 'confirmation_mismatch':
      return reply.code(409).send({ error: 'confirmation_mismatch', message: error.message });
    case 'audience_too_large':
      return reply.code(422).send({ error: 'audience_too_large', message: error.message });
    case 'validation':
      return reply.code(400).send({ error: 'bad_request', message: error.message });
    case 'conflict':
      return reply.code(409).send({ error: 'conflict', message: error.message });
    default:
      return reply.code(502).send({ error: 'push_admin_unavailable' });
  }
}

export function registerPushAdminRoutes(opts: {
  app: FastifyInstance;
  authenticator: Authenticator;
  stores: Record<PushAdminEnv, PushCampaignStore>;
  allowedClientId: string;
}): void {
  const { app, authenticator, stores, allowedClientId } = opts;

  async function authorized(
    request: Parameters<Authenticator['authenticate']>[0],
    reply: FastifyReply,
  ): Promise<{ authorized: true; clientId: string } | null> {
    const auth = await authenticator.authenticate(request);
    if (!auth.authorized) {
      reply.code(401).send({ error: 'unauthorized' });
      return null;
    }
    if (auth.clientId !== allowedClientId) {
      reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return { authorized: true, clientId: auth.clientId };
  }

  app.post('/push-admin/campaigns/list', async (request, reply) => {
    if (!(await authorized(request, reply))) return;
    const parsed = listSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const store = storeFor(stores, parsed.data.env, reply);
    if (!store) return;
    try {
      const [campaigns, worker] = await Promise.all([
        store.listCampaigns(parsed.data.limit ?? 100),
        store.getWorkerStatus(WORKER_HEALTH_MAX_AGE_MS),
      ]);
      return reply.code(200).send({ campaigns, worker });
    } catch (error) {
      app.log.error({ code: error instanceof PushStoreError ? error.code : 'unknown' }, 'push campaigns list failed');
      return sendStoreError(reply, error);
    }
  });

  app.post('/push-admin/campaigns/get', async (request, reply) => {
    if (!(await authorized(request, reply))) return;
    const parsed = getSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const store = storeFor(stores, parsed.data.env, reply);
    if (!store) return;
    try {
      const campaign = await store.getCampaign(parsed.data.id);
      if (!campaign) return reply.code(404).send({ error: 'campaign_not_found' });
      return reply.code(200).send({ campaign });
    } catch (error) {
      app.log.error({ code: error instanceof PushStoreError ? error.code : 'unknown' }, 'push campaign get failed');
      return sendStoreError(reply, error);
    }
  });

  app.post('/push-admin/campaigns/upsert', async (request, reply) => {
    const auth = await authorized(request, reply);
    if (!auth) return;
    const parsed = upsertSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const store = storeFor(stores, parsed.data.env, reply);
    if (!store) return;
    try {
      const campaign = await store.upsertDraft(
        {
          commandId: parsed.data.commandId,
          id: parsed.data.id,
          expectedRevision: parsed.data.expectedRevision,
          dedupKey: parsed.data.dedupKey,
          title: parsed.data.title,
          body: parsed.data.body,
          path: parsed.data.path,
          audienceMode: parsed.data.audienceMode,
          consentBasis: parsed.data.consentBasis ?? null,
          scheduledAt: parsed.data.scheduledAt ?? null,
          maxRecipients: parsed.data.maxRecipients,
        },
        auth.clientId,
      );
      return reply.code(200).send({ campaign });
    } catch (error) {
      app.log.error({ code: error instanceof PushStoreError ? error.code : 'unknown' }, 'push campaign upsert failed');
      return sendStoreError(reply, error);
    }
  });

  app.post('/push-admin/campaigns/prepare', async (request, reply) => {
    const auth = await authorized(request, reply);
    if (!auth) return;
    const parsed = actionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const store = storeFor(stores, parsed.data.env, reply);
    if (!store) return;
    try {
      const campaign = await store.prepareCampaign(
        parsed.data.id,
        parsed.data.expectedRevision,
        parsed.data.commandId,
        auth.clientId,
      );
      return reply.code(200).send({ campaign });
    } catch (error) {
      app.log.error({ code: error instanceof PushStoreError ? error.code : 'unknown' }, 'push campaign prepare failed');
      return sendStoreError(reply, error);
    }
  });

  app.post('/push-admin/campaigns/queue', async (request, reply) => {
    const auth = await authorized(request, reply);
    if (!auth) return;
    const parsed = queueSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    if (parsed.data.confirmation !== String(parsed.data.expectedEligibleUsers)) {
      return reply.code(400).send({ error: 'bad_confirmation', message: 'Confirmation must equal the recipient count' });
    }
    const store = storeFor(stores, parsed.data.env, reply);
    if (!store) return;
    try {
      const worker = await store.getWorkerStatus(WORKER_HEALTH_MAX_AGE_MS);
      if (!worker.enabled || !worker.healthy) {
        return reply.code(503).send({ error: 'worker_unavailable' });
      }
      const campaign = await store.queueCampaign(
        {
          id: parsed.data.id,
          expectedRevision: parsed.data.expectedRevision,
          commandId: parsed.data.commandId,
          expectedEligibleUsers: parsed.data.expectedEligibleUsers,
          expectedAudienceDigest: parsed.data.expectedAudienceDigest.toLowerCase(),
          expectedPayloadHash: parsed.data.expectedPayloadHash.toLowerCase(),
          confirmation: parsed.data.confirmation,
          maxRecipients: parsed.data.maxRecipients,
        },
        auth.clientId,
      );
      return reply.code(202).send({ campaign });
    } catch (error) {
      app.log.error({ code: error instanceof PushStoreError ? error.code : 'unknown' }, 'push campaign queue failed');
      return sendStoreError(reply, error);
    }
  });

  app.post('/push-admin/campaigns/cancel', async (request, reply) => {
    const auth = await authorized(request, reply);
    if (!auth) return;
    const parsed = actionSchema.safeParse(request.body ?? {});
    if (!parsed.success) return invalidBody(reply, parsed.error);
    const store = storeFor(stores, parsed.data.env, reply);
    if (!store) return;
    try {
      const campaign = await store.cancelCampaign(
        parsed.data.id,
        parsed.data.expectedRevision,
        parsed.data.commandId,
        auth.clientId,
      );
      return reply.code(200).send({ campaign });
    } catch (error) {
      app.log.error({ code: error instanceof PushStoreError ? error.code : 'unknown' }, 'push campaign cancel failed');
      return sendStoreError(reply, error);
    }
  });
}
