import { describe, it, expect, vi } from 'vitest';
import { createHeadlineChecker, headlineMatches, normalizeLetters, TRANSCRIBE_PROMPT } from './headline-check';

describe('headlineMatches', () => {
  it('кавычки, регистр, дефисы, пробелы и ё/е не считаются расхождением', () => {
    expect(headlineMatches('«Кофемашины на любой вкус»', 'Кофемашины на любой вкус')).toBe(true);
    expect(headlineMatches('МАГАЗИН АВТОЗАПЧАСТЕЙ АВТО 777', 'Магазин автозапчастей АВТО-777')).toBe(true);
    expect(headlineMatches('Всё для питомцев', 'Все для питомцев')).toBe(true);
  });

  it('логотипы с фото рядом с заголовком не мешают', () => {
    expect(headlineMatches('АВТОЗАПЧАСТИ Магазин автозапчастей АВТО-777 ESSO Mobil Castrol', 'Магазин автозапчастей АВТО-777')).toBe(true);
  });

  it('опечатка или вставка внутри заголовка — расхождение (случаи с тест-стенда)', () => {
    expect(headlineMatches('Строим дома под ключ с ПВЗ Дом', 'Строим дома под ключ с Твой Дом')).toBe(false);
    expect(headlineMatches('«Магазин автозапчастей и холяц АВТО-777»', 'Магазин автозапчастей АВТО-777')).toBe(false);
    expect(headlineMatches('Кроссовки New Balance сожий 30%', 'Скидка 30% на кроссовки New Balance')).toBe(false);
  });

  it('пустой ожидаемый текст — проверять нечего', () => {
    expect(headlineMatches('что угодно', '')).toBe(true);
    expect(headlineMatches('что угодно', ' — ')).toBe(true);
  });

  it('normalizeLetters оставляет только буквы и цифры', () => {
    expect(normalizeLetters(' «АВТО-777» ')).toBe('авто777');
  });
});

describe('createHeadlineChecker', () => {
  const cfg = { apiKey: 'k', model: 'google/test-vision', timeoutMs: 5000 };

  it('шлёт картинку с инструкцией переписать текст и возвращает ответ модели', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: 'Строим дома под ключ с Твой Дом' } }],
    }), { status: 200 }));
    const checker = createHeadlineChecker({ config: cfg, fetchImpl });

    await expect(checker.transcribe('data:image/webp;base64,AQID')).resolves.toBe('Строим дома под ключ с Твой Дом');
    const sent = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(sent.model).toBe('google/test-vision');
    expect(sent.temperature).toBe(0);
    expect(sent.messages[0].content).toEqual([
      { type: 'text', text: TRANSCRIBE_PROMPT },
      { type: 'image_url', image_url: { url: 'data:image/webp;base64,AQID' } },
    ]);
  });

  it('ошибка HTTP и ответ без текста — исключение (пайплайн примет картинку без проверки)', async () => {
    await expect(createHeadlineChecker({ config: cfg, fetchImpl: vi.fn().mockResolvedValue(new Response('busy', { status: 503, statusText: 'Unavailable' })) }).transcribe('data:image/webp;base64,AQID'))
      .rejects.toThrow(/503/);
    await expect(createHeadlineChecker({ config: cfg, fetchImpl: vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: {} }] }), { status: 200 })) }).transcribe('data:image/webp;base64,AQID'))
      .rejects.toThrow(/no text/);
  });

  it('без ключа — ошибка до запроса', async () => {
    const fetchImpl = vi.fn();
    await expect(createHeadlineChecker({ config: { ...cfg, apiKey: '' }, fetchImpl }).transcribe('data:image/webp;base64,AQID'))
      .rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
