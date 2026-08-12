import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OpenrouterConfig } from '../config';
import type { OpenrouterImageConfig } from './openrouter-image-client';

const undici = vi.hoisted(() => ({
  fetch: vi.fn(),
  ProxyAgent: vi.fn(function ProxyAgent(this: { proxyUrl: string }, proxyUrl: string) {
    this.proxyUrl = proxyUrl;
  }),
}));

vi.mock('undici', () => ({
  fetch: undici.fetch,
  ProxyAgent: undici.ProxyAgent,
}));

const textConfig: OpenrouterConfig = {
  apiKey: 'sk-test-text',
  defaultModel: 'openai/gpt-4o-mini',
  pricePerMillionIn: 0.15,
  pricePerMillionOut: 0.6,
  usdRub: 100,
  timeoutMs: 5_000,
};

const imageConfig: OpenrouterImageConfig = {
  apiKey: 'sk-test-image',
  imageModel: 'google/gemini-test-image',
  pricePerImageUsd: 0.04,
  usdRub: 100,
  timeoutMs: 5_000,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function textResponse(): Response {
  return jsonResponse({
    model: textConfig.defaultModel,
    choices: [{ message: { content: 'proxied text' } }],
  });
}

function imageResponse(): Response {
  return jsonResponse({
    model: imageConfig.imageModel,
    choices: [{
      message: {
        images: [{ image_url: { url: 'data:image/png;base64,cHJveGllZA==' } }],
      },
    }],
  });
}

describe('OpenRouter transport selection', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('uses global fetch directly when OPENROUTER_PROXY is empty', async () => {
    vi.stubEnv('OPENROUTER_PROXY', '   ');
    const directFetch = vi.fn().mockResolvedValue(textResponse());
    vi.stubGlobal('fetch', directFetch);
    undici.fetch.mockImplementation(async () => textResponse());

    const { createOpenrouterClient } = await import('./openrouter-client');
    const client = createOpenrouterClient({ config: textConfig });

    await expect(client.call({ system: 'system', user: 'user' })).resolves.toMatchObject({
      text: 'proxied text',
    });
    expect(directFetch).toHaveBeenCalledOnce();
    expect(undici.fetch).not.toHaveBeenCalled();
    expect(undici.ProxyAgent).not.toHaveBeenCalled();
  });

  it('uses one undici ProxyAgent for default text client calls when configured', async () => {
    vi.stubEnv('OPENROUTER_PROXY', 'http://100.76.223.55:8888');
    const directFetch = vi.fn().mockResolvedValue(
      new Response('Access denied by security policy', { status: 403 }),
    );
    vi.stubGlobal('fetch', directFetch);
    undici.fetch.mockImplementation(async () => textResponse());

    const { createOpenrouterClient } = await import('./openrouter-client');
    const client = createOpenrouterClient({ config: textConfig });

    await client.call({ system: 'system', user: 'first' });
    await client.call({ system: 'system', user: 'second' });

    expect(directFetch).not.toHaveBeenCalled();
    expect(undici.ProxyAgent).toHaveBeenCalledOnce();
    expect(undici.ProxyAgent).toHaveBeenCalledWith('http://100.76.223.55:8888');
    expect(undici.fetch).toHaveBeenCalledTimes(2);
    expect(undici.fetch).toHaveBeenCalledWith(
      'https://openrouter.ai/api/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        dispatcher: undici.ProxyAgent.mock.instances[0],
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('uses the proxy transport for the default image client too', async () => {
    vi.stubEnv('OPENROUTER_PROXY', 'http://proxy.internal:8888');
    const directFetch = vi.fn().mockResolvedValue(
      new Response('Access denied by security policy', { status: 403 }),
    );
    vi.stubGlobal('fetch', directFetch);
    undici.fetch.mockResolvedValue(imageResponse());

    const { createOpenrouterImageClient } = await import('./openrouter-image-client');
    const client = createOpenrouterImageClient({ config: imageConfig });

    await expect(client.call({ prompt: 'add text', imageUrl: 'https://example.com/a.png' }))
      .resolves.toMatchObject({ imageDataUrl: 'data:image/png;base64,cHJveGllZA==' });
    expect(directFetch).not.toHaveBeenCalled();
    expect(undici.fetch).toHaveBeenCalledOnce();
  });

  it('keeps injected fetchImpl ahead of the configured proxy for both clients', async () => {
    vi.stubEnv('OPENROUTER_PROXY', 'http://proxy.internal:8888');
    const directFetch = vi.fn();
    vi.stubGlobal('fetch', directFetch);
    const textFetch = vi.fn().mockResolvedValue(textResponse());
    const imageFetch = vi.fn().mockResolvedValue(imageResponse());

    const { createOpenrouterClient } = await import('./openrouter-client');
    const { createOpenrouterImageClient } = await import('./openrouter-image-client');
    const textClient = createOpenrouterClient({ config: textConfig, fetchImpl: textFetch });
    const imageClient = createOpenrouterImageClient({ config: imageConfig, fetchImpl: imageFetch });

    await textClient.call({ system: 'system', user: 'user' });
    await imageClient.call({ prompt: 'add text', imageUrl: 'https://example.com/a.png' });

    expect(textFetch).toHaveBeenCalledOnce();
    expect(imageFetch).toHaveBeenCalledOnce();
    expect(directFetch).not.toHaveBeenCalled();
    expect(undici.fetch).not.toHaveBeenCalled();
    expect(undici.ProxyAgent).not.toHaveBeenCalled();
  });
});
