/**
 * Референс для модели картинок — всегда base64 data URL. Google AI Studio
 * (через OpenRouter) за картинкой по нашему адресу сам не ходит: на
 * тест-стенде 14.10.2026 каждый вызов с https://supabase-aa.apsoftgroup.ru/…
 * падал в 400 «Unsupported URL, public internet addresses only», хотя адрес
 * публичный. Поэтому картинку из нашего же хранилища скачивает BFF и
 * вкладывает в запрос.
 *
 * Скачиваем только с разрешённых префиксов (публичный бакет AA-Supabase):
 * imageUrl приходит из браузера рекламодателя через кабинет, и без границы
 * BFF стал бы прокси до любого адреса (SSRF). Чужой адрес уходит модели как
 * есть — как и раньше.
 */
export interface ReferenceInlinerOpts {
  /** Префиксы адресов, которые BFF скачивает сам; остальные не трогает. */
  allowedPrefixes: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
}

export type ReferenceInliner = (imageUrl: string) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 15_000;
/** Файл рекламодателя после сжатия кабинетом — сотни килобайт; 12 МиБ — запас
 *  с потолком, чтобы случайный гигант не лёг в память целиком. */
const DEFAULT_MAX_BYTES = 12 * 1024 * 1024;

export function createReferenceInliner(opts: ReferenceInlinerOpts): ReferenceInliner {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const prefixes = opts.allowedPrefixes.filter((p) => p.length > 0);

  return async (imageUrl) => {
    if (!prefixes.some((p) => imageUrl.startsWith(p))) return imageUrl;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(imageUrl, { signal: controller.signal });
    } catch (err) {
      clearTimeout(timer);
      const name = (err as { name?: string } | null)?.name;
      if (name === 'AbortError') throw new Error(`reference-image: timed out after ${timeoutMs}ms`);
      throw err;
    }
    clearTimeout(timer);

    if (!resp.ok) throw new Error(`reference-image: ${resp.status} ${resp.statusText}`);
    const type = (resp.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) throw new Error(`reference-image: not an image (${type || 'no content-type'})`);
    const declared = Number(resp.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new Error(`reference-image: too large (${declared} bytes)`);

    const bytes = Buffer.from(await resp.arrayBuffer());
    if (bytes.length === 0) throw new Error('reference-image: empty body');
    if (bytes.length > maxBytes) throw new Error(`reference-image: too large (${bytes.length} bytes)`);
    return `data:${type};base64,${bytes.toString('base64')}`;
  };
}
