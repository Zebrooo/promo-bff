import { describe, it, expect, vi } from 'vitest';
import { createReferenceInliner } from './reference-image';

const STORAGE = 'https://supabase.example/storage/v1/object/public/';

function imageResponse(bytes: Uint8Array, type = 'image/webp', extraHeaders: Record<string, string> = {}) {
  return new Response(bytes, { status: 200, headers: { 'content-type': type, ...extraHeaders } });
}

describe('createReferenceInliner', () => {
  it('адрес нашего хранилища скачивается и вкладывается как data URL с его MIME', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3]), 'image/webp; charset=binary'));
    const inline = createReferenceInliner({ allowedPrefixes: [STORAGE], fetchImpl });

    await expect(inline(`${STORAGE}ad-creatives/u/x.webp`)).resolves.toBe('data:image/webp;base64,AQID');
    expect(fetchImpl).toHaveBeenCalledWith(`${STORAGE}ad-creatives/u/x.webp`, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it('чужой адрес и готовый data URL не трогаются и не скачиваются', async () => {
    const fetchImpl = vi.fn();
    const inline = createReferenceInliner({ allowedPrefixes: [STORAGE], fetchImpl });

    await expect(inline('https://evil.example/x.png')).resolves.toBe('https://evil.example/x.png');
    await expect(inline('data:image/png;base64,AQID')).resolves.toBe('data:image/png;base64,AQID');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('пустой префикс в списке не превращается в «разрешено всё»', async () => {
    const fetchImpl = vi.fn();
    const inline = createReferenceInliner({ allowedPrefixes: [''], fetchImpl });
    await expect(inline('https://anything.example/x.png')).resolves.toBe('https://anything.example/x.png');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('ответ не 2xx, не картинка или пустое тело — ошибка', async () => {
    const url = `${STORAGE}ad-creatives/u/x.webp`;
    await expect(createReferenceInliner({ allowedPrefixes: [STORAGE], fetchImpl: vi.fn().mockResolvedValue(new Response('nope', { status: 404, statusText: 'Not Found' })) })(url))
      .rejects.toThrow(/404/);
    await expect(createReferenceInliner({ allowedPrefixes: [STORAGE], fetchImpl: vi.fn().mockResolvedValue(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })) })(url))
      .rejects.toThrow(/not an image/);
    await expect(createReferenceInliner({ allowedPrefixes: [STORAGE], fetchImpl: vi.fn().mockResolvedValue(imageResponse(new Uint8Array(0))) })(url))
      .rejects.toThrow(/empty/);
  });

  it('слишком большой файл отвергается по заголовку и по телу', async () => {
    const url = `${STORAGE}ad-creatives/u/x.webp`;
    await expect(createReferenceInliner({ allowedPrefixes: [STORAGE], maxBytes: 2, fetchImpl: vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1]), 'image/png', { 'content-length': '999' })) })(url))
      .rejects.toThrow(/too large/);
    await expect(createReferenceInliner({ allowedPrefixes: [STORAGE], maxBytes: 2, fetchImpl: vi.fn().mockResolvedValue(imageResponse(new Uint8Array([1, 2, 3]))) })(url))
      .rejects.toThrow(/too large/);
  });

  it('таймаут — ошибка с указанием срока', async () => {
    const fetchImpl = vi.fn((_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    const inline = createReferenceInliner({ allowedPrefixes: [STORAGE], fetchImpl: fetchImpl as unknown as typeof fetch, timeoutMs: 10 });
    await expect(inline(`${STORAGE}x.webp`)).rejects.toThrow(/timed out after 10ms/);
  });
});
