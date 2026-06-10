import { describe, it, expect, vi } from 'vitest';
import { createOpenrouterClient } from './openrouter-client';
import type { OpenrouterConfig } from '../config';

const baseConfig: OpenrouterConfig = {
  apiKey: 'sk-test-xxx',
  defaultModel: 'openai/gpt-4o-mini',
  pricePerMillionIn: 0.15,
  pricePerMillionOut: 0.60,
  usdRub: 100,
  timeoutMs: 5000,
};

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('openrouter-client', () => {
  it('POSTs system+user messages to the chat-completions endpoint and returns text+usage+costRub', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        model: 'openai/gpt-4o-mini',
        usage: { prompt_tokens: 1000, completion_tokens: 500 },
        choices: [{ message: { content: 'enhanced!' } }],
      }),
    );
    const client = createOpenrouterClient({ config: baseConfig, fetchImpl });

    const result = await client.call({ system: 'rewrite', user: 'draft' });

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sk-test-xxx');
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['HTTP-Referer']).toBeUndefined();
    expect(headers['X-Title']).toBeUndefined();

    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('openai/gpt-4o-mini');
    expect(body.messages).toEqual([
      { role: 'system', content: 'rewrite' },
      { role: 'user', content: 'draft' },
    ]);
    // No max_tokens / temperature when caller didn't specify them.
    expect(body.max_tokens).toBeUndefined();
    expect(body.temperature).toBeUndefined();

    expect(result.text).toBe('enhanced!');
    expect(result.tokensIn).toBe(1000);
    expect(result.tokensOut).toBe(500);
    // 1000/1M * 0.15 + 500/1M * 0.60 = 0.00015 + 0.00030 = 0.00045 USD
    // × 100 RUB/USD = 0.045 RUB
    expect(result.costRub).toBeCloseTo(0.045, 6);
    expect(result.model).toBe('openai/gpt-4o-mini');
  });

  it('overrides model, max_tokens, temperature per call', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        choices: [{ message: { content: '.' } }],
      }),
    );
    const client = createOpenrouterClient({ config: baseConfig, fetchImpl });

    await client.call({
      system: 's',
      user: 'u',
      model: 'anthropic/claude-3-haiku',
      maxTokens: 200,
      temperature: 0.5,
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('anthropic/claude-3-haiku');
    expect(body.max_tokens).toBe(200);
    expect(body.temperature).toBe(0.5);
  });

  it('attaches HTTP-Referer / X-Title when configured', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({
        usage: { prompt_tokens: 0, completion_tokens: 0 },
        choices: [{ message: { content: '.' } }],
      }),
    );
    const client = createOpenrouterClient({
      config: baseConfig,
      fetchImpl,
      referer: 'https://example.com',
      appTitle: 'promo-bff',
    });

    await client.call({ system: 's', user: 'u' });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['HTTP-Referer']).toBe('https://example.com');
    expect(headers['X-Title']).toBe('promo-bff');
  });

  it('throws when the API key is empty (config error, no HTTP)', async () => {
    const fetchImpl = vi.fn();
    const client = createOpenrouterClient({
      config: { ...baseConfig, apiKey: '' },
      fetchImpl,
    });

    await expect(client.call({ system: 's', user: 'u' })).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws a labelled error on non-2xx with body excerpt (≤200 chars)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('rate limited', { status: 429, statusText: 'Too Many Requests' }),
    );
    const client = createOpenrouterClient({ config: baseConfig, fetchImpl });

    await expect(client.call({ system: 's', user: 'u' })).rejects.toThrow(
      /429.*Too Many Requests.*rate limited/,
    );
  });

  it('throws on malformed response (no choices[0].message.content)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ choices: [] }));
    const client = createOpenrouterClient({ config: baseConfig, fetchImpl });

    await expect(client.call({ system: 's', user: 'u' })).rejects.toThrow(/empty response/);
  });

  it('aborts and throws a clear timeout error past timeoutMs', async () => {
    // Mock fetch to never resolve until aborted via the signal.
    const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      }),
    );
    const client = createOpenrouterClient({
      config: { ...baseConfig, timeoutMs: 10 },
      fetchImpl,
    });

    await expect(client.call({ system: 's', user: 'u' })).rejects.toThrow(/timed out after 10ms/);
  });

  it('defaults tokensIn/tokensOut to 0 when usage is missing (cost is then 0 RUB)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ choices: [{ message: { content: 'hi' } }] }),
    );
    const client = createOpenrouterClient({ config: baseConfig, fetchImpl });

    const result = await client.call({ system: 's', user: 'u' });
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
    expect(result.costRub).toBe(0);
  });
});
