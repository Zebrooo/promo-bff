/**
 * Промпт для /enhance-banner-image: из фото рекламодателя + заголовка сделать
 * готовый баннер. Что здесь учтено и почему — по следам разбора 14.10.2026
 * (образцы с тест-стенда и три прогона A/B на нём же):
 *
 *   - Рекламодатели грузят не баннеры, а обычные фото (стройка, фасад
 *     магазина, товар на столе). Поэтому референс описан как «фото предмета
 *     рекламы», а не как «баннер, который надо улучшить»: модель вырезает
 *     предмет и собирает раскладку заново, а не дорисовывает текст поверх.
 *   - Прежний промпт требовал «только фон в углах» с длинным списком «никаких
 *     панелей, стёкол, прямоугольников» — и модель рисовала в углах ровно
 *     такие светлые прямоугольники. А фраза «здесь сайт поставит кнопку»
 *     давала в зоне белую плашку-кнопку. Теперь зона описана как часть
 *     раскладки, без объяснения зачем, и слов «кнопка/панель/прямоугольник»
 *     в промпте нет вовсе.
 *   - Текст страдал: «со скидкой» → «сожий», заголовок перефразировался,
 *     «ёлочки» вокруг текста модель рисовала на баннере, слово на переносе
 *     строки удваивалось. Текст идёт отдельной строкой без кавычек, число
 *     строк и кегль заданы от длины, в конце — просьба сверить написание.
 *     Остаточные опечатки ловит сверка в пайплайне (headline-check.ts).
 *   - Форму кадра задаёт `image_config.aspect_ratio` (см. pipeline), а промпт
 *     её только повторяет словами и задаёт запас по краям под cover-кроп
 *     телефонной полосы (4:1 → 4,83:1).
 *
 * Инструкции по-английски (модель точнее следует английскому), сам текст
 * баннера — по-русски, дословно.
 */
import { bannerShape, pickAspectRatio } from '../../services/banner-aspect';
import type { EnhanceBannerImageParams } from './types';

type Side = 'left' | 'right';
type Vertical = 'top' | 'bottom';

const CORNERS: Record<string, { side: Side; vertical: Vertical }> = {
  tl: { side: 'left', vertical: 'top' },
  tr: { side: 'right', vertical: 'top' },
  bl: { side: 'left', vertical: 'bottom' },
  br: { side: 'right', vertical: 'bottom' },
};

const OPPOSITE_SIDE: Record<Side, Side> = { left: 'right', right: 'left' };
const OPPOSITE_VERTICAL: Record<Vertical, Vertical> = { top: 'bottom', bottom: 'top' };

/** Текст в промпт: схлопнуть пробелы, прямые кавычки → «ёлочки», чтобы
 *  внутренние кавычки заголовка не читались как разметка. */
export function cleanBannerText(raw: string | undefined): string {
  if (!raw) return '';
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/"([^"]*)"/g, '«$1»')
    .replace(/"/g, '');
}

/** Главный текст баннера — заголовок, без него описание. Его же пайплайн
 *  сверяет с готовой картинкой (expectedText). */
export function bannerHeadlineText(draft: EnhanceBannerImageParams['draft']): string {
  return cleanBannerText(draft.title) || cleanBannerText(draft.description);
}

function lineAdvice(length: number, shape: ReturnType<typeof bannerShape>): string {
  if (shape === 'strip') {
    if (length <= 22) return 'on a single line';
    if (length <= 44) return 'broken into two balanced lines';
    return 'broken into two or three short balanced lines';
  }
  if (length <= 18) return 'on a single line';
  if (length <= 40) return 'broken into two balanced lines';
  return 'broken into two or three balanced lines';
}

function shapeLine(width: number, height: number, aspect: string): string {
  const shape = bannerShape(width, height);
  const ratio = width / height;
  if (shape === 'strip') {
    return `a very wide horizontal strip, aspect ratio ${aspect} (about ${ratio.toFixed(1)} times wider than tall, ${width}×${height} px)`;
  }
  if (shape === 'landscape') return `a landscape rectangle, aspect ratio ${aspect} (${width}×${height} px)`;
  if (shape === 'square') return `a square, aspect ratio ${aspect} (${width}×${height} px)`;
  return `a vertical poster, aspect ratio ${aspect} (${width}×${height} px, taller than wide)`;
}

/** Зона кнопки витрины — без объяснения, зачем она пуста: объяснение
 *  («здесь будет кнопка») модель воплощала плашкой. */
function reservedLine(zone: string): string {
  return `- ${capitalize(zone)}: RESERVED — plain continuous background only; it looks exactly like the background beside it, with nothing placed in it, not even the end of a headline line.`;
}

interface Layout {
  heading: string;
  lines: string[];
  /** Короткое имя зоны кнопки для финальной проверки. */
  reserved: string;
}

function layoutFor(params: EnhanceBannerImageParams, lines: string): Layout {
  const corner = CORNERS[params.ctaPosition ?? 'br'] ?? CORNERS.br;
  const shape = bannerShape(params.width, params.height);
  const near = corner.side;
  const far = OPPOSITE_SIDE[near];

  if (shape === 'strip') {
    const reserved = `${near} 25 % of the width`;
    // Короткой полосе (4:1) две строки крупного кегля не влезают — текст
    // расползался в зону кнопки; предмет уже, кегль ниже.
    const long = params.width / params.height >= 6;
    const subjectZone = long ? 'third' : 'quarter';
    const capHeight = long ? '35–45 %' : '22–30 %';
    return {
      heading: 'LAYOUT — a wide strip, read left to right in three zones',
      lines: [
        `- ${capitalize(far)} ${subjectZone}: the subject, large, filling the full height (it may run off the ${far} edge).`,
        `- Middle: the headline on the plain background, left-aligned and starting right after the subject, ${lines}; cap height about ${capHeight} of the strip height. If it does not fit, make it smaller — its longest line ends before the reserved zone.`,
        reservedLine(reserved),
      ],
      reserved,
    };
  }

  if (shape === 'landscape') {
    const reserved = `${near}-${corner.vertical} quarter (about 35 % of the width × 35 % of the height)`;
    return {
      heading: 'LAYOUT — a landscape rectangle',
      lines: [
        `- ${capitalize(far)} half: the subject, large.`,
        `- ${capitalize(near)} half, ${OPPOSITE_VERTICAL[corner.vertical]} part: the headline, ${lines}, aligned ${far}.`,
        reservedLine(reserved),
      ],
      reserved,
    };
  }

  // Квадрат и портрет: раскладка сверху вниз, зона кнопки — полоса во всю ширину.
  const headlineBand = OPPOSITE_VERTICAL[corner.vertical];
  const reserved = `${corner.vertical} 30 % of the height`;
  return {
    heading: 'LAYOUT — a poster, read top to bottom',
    lines: [
      `- ${capitalize(headlineBand)} part (about 25 % of the height): the headline, ${lines}, spanning up to 80 % of the width, aligned left.`,
      '- Middle: the subject, large and centred.',
      reservedLine(reserved),
    ],
    reserved,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function buildEnhanceBannerImagePrompt(params: EnhanceBannerImageParams): string {
  const { width, height } = params;
  const aspect = pickAspectRatio(width, height);
  const shape = bannerShape(width, height);
  const title = cleanBannerText(params.draft.title);
  const primary = bannerHeadlineText(params.draft);
  const secondary = title ? cleanBannerText(params.draft.description) : '';
  const layout = layoutFor(params, lineAdvice(primary.length, shape));

  const lines: string[] = [];
  lines.push(`Design a finished display-ad banner for a Russian online classifieds site (cars, property, goods and services in Abkhazia). Output: ${shapeLine(width, height, aspect)}. Full-bleed, no margins or border.`);
  lines.push('');
  lines.push('REFERENCE');
  lines.push("The attached image is the advertiser's own photo or current banner. It shows WHAT is advertised. Keep that subject recognisable — the same product, vehicle, building, goods or place, with its real colours, and any logo or brand mark exactly as it appears. Everything else is yours to redesign: lift the subject out of cluttered surroundings or re-stage it, rebuild the layout, choose the background and lighting. Do not carry over the reference's old text, watermarks, noise or blur.");
  lines.push('');
  lines.push('HEADLINE — the only text in the image');
  lines.push('Render exactly the Russian text on the next line — letter for letter, in correct Cyrillic spelling, keeping its punctuation and capitalisation, each word written exactly once (no word repeated across a line break), and without adding quotation marks around it:');
  lines.push(primary);
  if (secondary) {
    lines.push('Below it, smaller and lighter, exactly the text on the next line:');
    lines.push(secondary);
  }
  lines.push('Nothing else is written anywhere in the image: no extra words, letters, digits, prices, phone numbers, URLs, hashtags, slogans or watermarks, and no invented brand names. Typography: a clean modern bold sans-serif (geometric, in the spirit of Inter or Manrope), upright, perfectly legible with crisp edges — no outline, glow, perspective or distortion. High contrast: dark text on a light field or white text on a deep solid field, never across a busy area.');
  lines.push('');
  lines.push(layout.heading);
  lines.push(...layout.lines);
  lines.push('Keep the headline and the important details of the subject inside the safe area: at least 8 % of the height away from the top and bottom edges and 5 % of the width away from the sides.');
  lines.push('');
  lines.push('LOOK');
  lines.push("Bright, clean, premium commercial quality — a banner a leading marketplace would run. Soft, even studio lighting; natural true-to-life colours; the whole frame uniformly sharp from edge to edge, background included (deep focus). The background is one calm continuous field — a solid colour or a smooth two-tone gradient that complements the subject and any brand colours from the reference — with no texture, pattern or scenery. The subject stands on it with a soft natural contact shadow. A photographed subject stays photo-real; an illustrated one stays flat vector. Apart from the subject, the headline and the plain background, the image contains nothing else.");
  lines.push('');
  lines.push(`Final check before you output: the headline reads exactly: ${primary} — every letter correct, each word once, no quotation marks added; the reserved ${layout.reserved} is plain background identical to its surroundings; nothing important touches the edges; the image is ${aspect}.`);
  return lines.join('\n');
}
