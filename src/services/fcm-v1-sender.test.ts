import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFcmSender,
  loadFcmServiceAccount,
  type FcmServiceAccount,
} from './fcm-v1-sender';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const account: FcmServiceAccount = {
  client_email: 'push@example-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  project_id: 'example-project',
};

const oauthOk = () =>
  new Response(JSON.stringify({ access_token: 'access-token', expires_in: 3600 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

const fcmError = (status: number, errorCode?: string, providerStatus = 'INVALID_ARGUMENT') =>
  new Response(
    JSON.stringify({
      error: {
        status: providerStatus,
        details: errorCode
          ? [
              {
                '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError',
                errorCode,
              },
            ]
          : [],
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  );

afterEach(() => vi.restoreAllMocks());

describe('FCM HTTP v1 sender', () => {
  it('loads a valid mounted key only when its Firebase project matches the explicit pin', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'promo-fcm-test-'));
    const file = join(dir, 'service-account.json');
    try {
      await writeFile(
        file,
        JSON.stringify({ ...account, token_uri: 'https://oauth2.googleapis.com/token' }),
        { mode: 0o600 },
      );
      await expect(loadFcmServiceAccount(file, 'example-project')).resolves.toEqual(account);
      await expect(loadFcmServiceAccount(file, 'wrong-project')).rejects.toThrow(/pinned project id/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sends an accepted notification with the mobile uid guard but no campaign id', async () => {
    const acceptedResponse = new Response(JSON.stringify({ name: 'message-id' }), { status: 200 });
    const acceptedBody = vi.spyOn(acceptedResponse, 'arrayBuffer');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(acceptedResponse);
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(
      sender.send('device-token', 'ios', {
        title: 'Нужна запчасть?',
        body: 'Спросите сразу у магазинов',
        path: '/parts/request',
        data: { uid: '22222222-2222-4222-8222-222222222222' },
      }),
    ).resolves.toEqual({ kind: 'accepted' });

    const requestBody = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    expect(requestBody).toMatchObject({
      message: {
        token: 'device-token',
        data: {
          path: '/parts/request',
          kind: 'campaign',
          uid: '22222222-2222-4222-8222-222222222222',
        },
        apns: { payload: { aps: { sound: 'default' } } },
      },
    });
    expect(requestBody.message.data).not.toHaveProperty('campaignId');
    expect(acceptedBody).toHaveBeenCalledOnce();
  });

  it('keeps a proven FCM acceptance when best-effort response draining fails', async () => {
    const acceptedResponse = new Response('{}', { status: 200 });
    vi.spyOn(acceptedResponse, 'arrayBuffer').mockRejectedValueOnce(
      new Error('response stream failed'),
    );
    const cancelBody = vi.spyOn(acceptedResponse.body!, 'cancel');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(acceptedResponse);
    const sender = createFcmSender({
      serviceAccount: account,
      requestTimeoutMs: 1000,
      fetchImpl,
    });

    await expect(
      sender.send('device-token', 'android', { title: 'T', body: 'B', path: '/' }),
    ).resolves.toEqual({ kind: 'accepted' });
    expect(cancelBody).toHaveBeenCalledOnce();
  });

  it('only classifies the typed FCM UNREGISTERED detail as a stale token', async () => {
    const exactFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(fcmError(404, 'UNREGISTERED', 'NOT_FOUND'));
    const exact = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl: exactFetch });
    await expect(exact.send('dead-token', 'android', { title: 'T', body: 'B', path: '/' })).resolves.toEqual({
      kind: 'unregistered',
    });

    const genericFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(fcmError(404, undefined, 'NOT_FOUND'));
    const generic = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl: genericFetch });
    await expect(generic.send('token', 'android', { title: 'T', body: 'B', path: '/' })).resolves.toEqual({
      kind: 'failed',
      reason: 'provider_rejection',
      fatal: true,
    });
  });

  it('does not prune or halt the campaign for a typed invalid registration token', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(fcmError(400, 'INVALID_ARGUMENT'));
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(sender.send('token', 'ios', { title: 'T', body: 'B', path: '/' })).resolves.toEqual({
      kind: 'failed',
      reason: 'provider_invalid_registration_token',
      fatal: false,
    });
  });

  it('does not halt the campaign for a token from a different sender project', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(fcmError(403, 'SENDER_ID_MISMATCH', 'PERMISSION_DENIED'));
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(sender.send('token', 'ios', { title: 'T', body: 'B', path: '/' })).resolves.toEqual({
      kind: 'failed',
      reason: 'provider_token_project_mismatch',
      fatal: false,
    });
  });

  it('halts a campaign for a typed malformed message payload', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              status: 'INVALID_ARGUMENT',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.BadRequest',
                  fieldViolations: [{ field: 'message.data', description: 'invalid field' }],
                },
              ],
            },
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        ),
      );
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(sender.send('token', 'ios', { title: 'T', body: 'B', path: '/' })).resolves.toEqual({
      kind: 'failed',
      reason: 'provider_configuration_or_payload',
      fatal: true,
    });
  });

  it('refreshes OAuth once after an exact 401, then retries the same token', async () => {
    const firstUnauthorized = fcmError(401, undefined, 'UNAUTHENTICATED');
    const unauthorizedBody = vi.spyOn(firstUnauthorized, 'arrayBuffer');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(firstUnauthorized)
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(sender.send('same-token', 'android', { title: 'T', body: 'B', path: '/' })).resolves.toEqual({
      kind: 'accepted',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    const firstMessage = JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body));
    const secondMessage = JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body));
    expect(firstMessage.message.token).toBe('same-token');
    expect(secondMessage.message.token).toBe('same-token');
    expect(unauthorizedBody).toHaveBeenCalledOnce();
  });

  it('returns a nonfatal systemic outcome when OAuth refresh fails transiently after FCM 401', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockResolvedValueOnce(fcmError(401, undefined, 'UNAUTHENTICATED'))
      .mockResolvedValueOnce(new Response('{}', { status: 503 }));
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(
      sender.send('same-token', 'android', { title: 'T', body: 'B', path: '/' }),
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'oauth_rejected',
      fatal: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('single-flights OAuth exchange across a concurrent delivery batch', async () => {
    let oauthCalls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      if (String(input) === 'https://oauth2.googleapis.com/token') {
        oauthCalls += 1;
        return oauthOk();
      }
      return new Response('{}', { status: 200 });
    });
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sender.send(`token-${index}`, 'android', { title: 'T', body: 'B', path: '/' }),
      ),
    );
    expect(oauthCalls).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(9);
  });

  it('classifies OAuth transport/provider outages as transient before any FCM request', async () => {
    const oauthRejected = new Response('{}', { status: 503 });
    const rejectedBody = vi.spyOn(oauthRejected, 'arrayBuffer');
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthRejected);
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(sender.prepare?.()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'oauth_rejected',
      fatal: false,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(rejectedBody).toHaveBeenCalledOnce();
  });

  it('classifies explicit OAuth credential rejection as fatal before any FCM request', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 403 }));
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(sender.prepare?.()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'oauth_rejected',
      fatal: true,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('marks a network failure after request start unknown and does not retry', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(oauthOk())
      .mockRejectedValueOnce(new Error('socket reset'));
    const sender = createFcmSender({ serviceAccount: account, requestTimeoutMs: 1000, fetchImpl });
    await expect(sender.send('token', 'android', { title: 'T', body: 'B', path: '/' })).resolves.toEqual({
      kind: 'unknown',
      reason: 'network_ambiguity',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
