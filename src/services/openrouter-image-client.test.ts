import { describe, it, expect, vi } from 'vitest';
import { buildImageRequestBody, createOpenrouterImageClient } from './openrouter-image-client';

const cfg = { apiKey: 'test-key', imageModel: 'google/test-image', pricePerImageUsd: 0.04, usdRub: 100, timeoutMs: 5000 };

function imageResponse() {
  return new Response(JSON.stringify({
    model: 'google/test-image',
    choices: [{ message: { content: '', images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,cHJveGllZA==' } }] } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('buildImageRequestBody', () => {
  it('с референсом: текст + картинка в одном сообщении, image_config с соотношением сторон', () => {
    const body = buildImageRequestBody(
      { prompt: 'draw', imageUrl: 'https://example.com/a.png', aspectRatio: '8:1' },
      'google/test-image',
    );
    expect(body).toEqual({
      model: 'google/test-image',
      modalities: ['image', 'text'],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'draw' },
          { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
        ],
      }],
      image_config: { aspect_ratio: '8:1' },
    });
  });

  it('без референса картинки в сообщении нет (text-to-image), без aspect/size нет image_config', () => {
    const body = buildImageRequestBody({ prompt: 'draw' }, 'google/test-image');
    expect(body).toEqual({
      model: 'google/test-image',
      modalities: ['image', 'text'],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'draw' }] }],
    });
    expect(body).not.toHaveProperty('image_config');
  });

  it('image_size попадает в image_config, явная модель перекрывает умолчание', () => {
    const body = buildImageRequestBody({ prompt: 'draw', imageSize: '2K', model: 'google/other' }, 'google/test-image');
    expect(body.model).toBe('google/other');
    expect(body.image_config).toEqual({ image_size: '2K' });
  });
});

describe('createOpenrouterImageClient', () => {
  it('отправляет собранное тело и вытаскивает data URL из ответа', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse());
    const client = createOpenrouterImageClient({ config: cfg, fetchImpl });
    const result = await client.call({ prompt: 'draw', imageUrl: 'https://example.com/a.png', aspectRatio: '4:5' });

    expect(result).toEqual({ imageDataUrl: 'data:image/png;base64,cHJveGllZA==', model: 'google/test-image', costRub: 4 });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://openrouter.ai/api/v1/chat/completions');
    const sent = JSON.parse((init as RequestInit).body as string);
    expect(sent.image_config).toEqual({ aspect_ratio: '4:5' });
    expect(sent.messages[0].content).toHaveLength(2);
  });

  it('без ключа — ошибка конфигурации до запроса', async () => {
    const fetchImpl = vi.fn();
    const client = createOpenrouterImageClient({ config: { ...cfg, apiKey: '' }, fetchImpl });
    await expect(client.call({ prompt: 'draw' })).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
