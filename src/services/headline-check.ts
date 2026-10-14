/**
 * Проверка заголовка на готовом баннере. Nano Banana портит кириллицу примерно
 * в каждом четвёртом баннере («со скидкой» → «сожий», «Твой Дом» → «ПВЗ Дом»,
 * вставка «и холясу» посреди фразы), а для рекламодателя опечатка в названии —
 * повод отказаться от ИИ-картинки вовсе. Дешёвая мультимодальная модель
 * переписывает текст с картинки, пайплайн сверяет его с ожидаемым и при
 * расхождении генерирует картинку ещё раз (одна повторная попытка).
 *
 * Замер 14.10.2026 на 11 баннерах тест-стенда: gemini-2.5-flash-lite дала
 * 11/11 верных вердиктов (обе опечатки пойманы), gemini-3.1-flash-lite —
 * 10/11: она «исправила» опечатку при чтении. Поэтому умолчание — 2.5-lite,
 * ~0,0003 $ и ~2 с на проверку.
 */
import { config as appConfig } from '../config';
import { openrouterFetch } from './openrouter-fetch';

export interface HeadlineCheckConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
}

export interface HeadlineChecker {
  /** Весь текст с картинки, как его прочла модель. */
  transcribe(imageDataUrl: string): Promise<string>;
}

export const TRANSCRIBE_PROMPT =
  'Transcribe every piece of text visible in this image, exactly as written, character for character, including any typos or garbled words. Output only the transcription, one line per text block, nothing else.';

/** Только буквы и цифры в нижнем регистре: кавычки, дефисы, пробелы и регистр
 *  модель-читатель передаёт нестабильно, а опечатка — это всегда другая буква. */
export function normalizeLetters(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Заголовок на месте, если его буквы идут подряд где-то в прочитанном
 *  (рядом модель читает и логотипы с фото — они не мешают). */
export function headlineMatches(transcription: string, expected: string): boolean {
  const want = normalizeLetters(expected);
  if (!want) return true;
  return normalizeLetters(transcription).includes(want);
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

export function createHeadlineChecker(
  overrides: { config?: Partial<HeadlineCheckConfig>; fetchImpl?: typeof fetch } = {},
): HeadlineChecker {
  const cfg: HeadlineCheckConfig = { ...appConfig.headlineCheck, ...overrides.config };
  const fetchImpl = overrides.fetchImpl ?? openrouterFetch;

  return {
    async transcribe(imageDataUrl) {
      if (!cfg.apiKey) throw new Error('headline-check: OPENROUTER_API_KEY is not configured');
      const body = JSON.stringify({
        model: cfg.model,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: TRANSCRIBE_PROMPT },
            { type: 'image_url', image_url: { url: imageDataUrl } },
          ],
        }],
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
      let resp: Response;
      try {
        resp = await fetchImpl(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body,
          signal: controller.signal,
        });
      } catch (err) {
        clearTimeout(timer);
        const name = (err as { name?: string } | null)?.name;
        if (name === 'AbortError') throw new Error(`headline-check: timed out after ${cfg.timeoutMs}ms`);
        throw err;
      }
      clearTimeout(timer);

      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`headline-check: ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
      }
      const json = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = json.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error('headline-check: response had no text');
      return text;
    },
  };
}
