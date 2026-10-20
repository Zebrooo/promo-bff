/**
 * Промпт для /repair-banner-image: модератор витрины доводит баннер
 * рекламодателя до рекламных мест. Два режима:
 *
 *   - careful — правка присланной картинки по минимуму. Рекламодатель уже
 *     сделал баннер сам (фото, логотип, телефон, слоган), модератору надо
 *     поправить одно-два места, а не получить новый дизайн. Поэтому промпт
 *     говорит «отредактируй», перечисляет, что сохранить, и отдельно — что
 *     поменять: только выбранные правки и указания модератора.
 *   - rebuild — промпт /enhance-banner-image как есть плюс зоны и указания
 *     модератора в конце: собрать заново, но по его требованиям.
 *
 * Уроки enhance (шапка enhance-banner-image/prompt.ts) действуют и здесь:
 *   - зону под подпись витрины описываем как часть раскладки и не говорим,
 *     зачем она: «здесь будет кнопка» модель рисовала плашкой. Слов
 *     «кнопка/панель/прямоугольник/плашка» в промпте нет. По той же причине
 *     в careful нет ни цели правки, ни черновика объявления: русскую строку
 *     рядом с текстом баннера модель вписывает или «сверяет» с ней надпись;
 *   - кавычки вокруг текста модель рисовала на баннере. Указания модератора
 *     идут отдельным блоком с числом строк в шапке (граница, которая не
 *     рисуется), и прямо сказано: это команды, а не надпись, кавычки в них
 *     только отмечают формулировку;
 *   - обрезанный текст модель не угадывает ни при какой правке: перенос в
 *     безопасную зону или смена формы тянут строку целиком в кадр, и модель
 *     дописала бы её. Полная формулировка — только от модератора, иначе
 *     строку убрать или перенести как есть. Выдуманный телефон или цена на
 *     чужом баннере хуже обрезанной строки.
 *
 * Кадр модели и готовый файл — разной формы: модель рисует в pickAspectRatio,
 * транскод срезает лишнее под W×H (1160×240: кадр 4:1, от высоты остаётся
 * 83 %). Зоны модератора заданы в долях готового файла, поэтому переводим их
 * в доли кадра модели (coverCrop), а ручка кропит по центру — при кропе по
 * содержимому неизвестно, какой край уйдёт. В careful при заметном срезе
 * просим держать важное дальше от срезаемых краёв (rebuild держит запас
 * 8 % / 5 % из промпта enhance).
 *
 * Инструкции по-английски (модель точнее следует английскому), русский
 * текст — дословно.
 */
import { bannerShape, coverCrop, pickAspectRatio, type CoverCrop } from '../../services/banner-aspect';
import { buildEnhanceBannerImagePrompt, shapeLine } from '../enhance-banner-image/prompt';
import type { EnhanceBannerImageParams } from '../enhance-banner-image/types';
import { REPAIR_FIXES, type BannerZone, type RepairBannerImageParams, type RepairFix } from './types';

/** Доля → «12.5 %»: модель понимает проценты от ширины/высоты лучше долей. */
function percent(fraction: number): string {
  const value = Math.min(100, Math.max(0, Math.round(fraction * 1000) / 10));
  return `${value} %`;
}

/** Зона в долях готового файла → в доли кадра модели. Кроп по центру: по
 *  срезаемой оси от кадра остаётся середина длиной keep, по другой — всё. */
function toModelFrame(zone: BannerZone, crop: CoverCrop): BannerZone {
  const offset = (1 - crop.keep) / 2;
  return crop.axis === 'width'
    ? { ...zone, x: offset + zone.x * crop.keep, w: zone.w * crop.keep }
    : { ...zone, y: offset + zone.y * crop.keep, h: zone.h * crop.keep };
}

/** «across / down» вместо «of the width and … of the height»: связка «and»
 *  между двумя диапазонами читалась двояко. */
function zoneWords(zone: BannerZone, crop: CoverCrop): string {
  const z = toModelFrame(zone, crop);
  return `from ${percent(z.x)} to ${percent(z.x + z.w)} across and from ${percent(z.y)} to ${percent(z.y + z.h)} down`;
}

const POSITIONS_NOTE = 'positions are percentages of the image width, across from the left edge, and of its height, down from the top edge';

/** Срез меньше 1 % по оси не заметен — строку о запасе не пишем. */
const CROP_NOTICEABLE = 0.99;
/** Запас сверх самого среза: модель кладёт текст на глаз, а не по пикселю. */
const EDGE_SLACK = 0.02;

/** Запас от срезаемых краёв в careful: строка для REFERENCE и пункт проверки.
 *  rebuild не нужен — у enhance свой запас 8 % / 5 %. */
function edgeMargin(crop: CoverCrop): { line: string; check: string } | undefined {
  if (crop.keep >= CROP_NOTICEABLE) return undefined;
  const margin = `${Math.ceil(((1 - crop.keep) / 2 + EDGE_SLACK) * 100)} % of the ${crop.axis}`;
  const edges = crop.axis === 'height' ? 'top and bottom edges' : 'left and right edges';
  return {
    line: `Keep all text, the logo and the key details of the subject at least ${margin} away from the ${edges}, moving them in if they are closer; near those edges the existing background or photo simply continues.`,
    check: `all text, the logo and key details are at least ${margin} away from the ${edges}`,
  };
}

/** Пример перекладки под форму выхода: конкретному примеру модель следует
 *  точнее, чем «подстрой под форму». У квадрата направления нет. */
function rearrangeHint(width: number, height: number): string {
  const shape = bannerShape(width, height);
  if (shape === 'strip' || shape === 'landscape') return ' — side by side instead of stacked —';
  if (shape === 'portrait') return ' — stacked instead of side by side —';
  return ',';
}

/** Цитаты в указаниях («Полностью: «…»») — граница формулировки, а не часть
 *  текста; без этой фразы модель рисовала кавычки на баннере. */
const NOTES_QUOTES = 'Quotation marks in them only mark the exact wording and are never drawn.';

/** Шапка блока указаний. Указания — команды, а не надпись: иначе «Номер
 *  WhatsApp не меняй» оказывался допустимым текстом для картинки. Число строк
 *  отделяет блок от следующего — кавычки или теги модель нарисовала бы. */
function notesHeading(notes: string, overrides: string): string {
  const count = notes.split('\n').length;
  const span = count === 1 ? 'the next line holds' : `the next ${count} lines hold`;
  return `MODERATOR NOTES — ${span} instructions to you from the site's moderator, written in Russian; they are not text for the image. Only wording they explicitly ask to be written on the banner may appear on it. Follow them exactly; where they conflict with ${overrides}, the notes win. ${NOTES_QUOTES}`;
}

/** Строка правки для careful. Зона уже проверена валидатором: правка без неё
 *  до промпта не доходит. */
function fixLine(fix: RepairFix, params: RepairBannerImageParams, crop: CoverCrop): string {
  switch (fix) {
    case 'fit_safe_area':
      return `- Fit everything into the safe area: all text, the logo and the key details of the subject lie fully inside the area ${zoneWords(params.safeArea!, crop)}. Move them or scale them down evenly as much as needed, and no more, keeping their order and alignment; beyond that area the existing background or photo simply continues, with nothing important in it.`;
    case 'free_overlay_zone': {
      // Без объяснения, зачем зона пуста: объяснение модель воплощала плашкой.
      // При обеих зонах место для текста — их разность; скажем это прямо,
      // а не оставим модели вычитать прямоугольники.
      const both = params.fixes.includes('fit_safe_area')
        ? ' So everything important ends up inside the safe area and outside this area at the same time.'
        : '';
      return `- Keep the area ${zoneWords(params.reservedZone!, crop)} free: no text, logo or key details of the subject in it, not even the end of a line of text — move anything important out of it into free space elsewhere. Inside it the same background or photo continues, looking exactly like its surroundings, with nothing added.${both}`;
    }
    case 'restore_text':
      // Строка, которая не влезла целиком, иначе переносится самовольно — а
      // на переносе слово удваивалось (урок enhance).
      return '- Restore cut-off text: a line of text that runs off the edge or is partly hidden is written out in full and fully visible, using exactly the wording given in the moderator notes below, in the same font, colour and style as the rest of the text; if it does not fit at its size, make it slightly smaller or break it into two lines, each word written once (no word repeated across a line break).';
    case 'contrast':
      // «Затемни прямо за текстом» давало подложку по контуру текста — ту же
      // плашку, что в enhance. Градиент — широкий, без видимой границы.
      return '- Readability: every piece of text (the logo stays as it is) is clearly legible against what is behind it — change the text colour, or make the part of the picture under the text darker or lighter with a broad, soft gradient that fades out gradually over a large part of the image, so no edge or shape of it can be seen. The design otherwise stays the same.';
    case 'drop_small_text':
      return "- Remove small print: delete tiny secondary text that cannot be read at the banner's display size (fine print, long lists, small captions) and continue the background where it was. Keep the main headline, the brand name and every contact detail (phone numbers, WhatsApp, Telegram, address, website); if a contact detail is too small to read, enlarge it without changing a single character.";
    case 'clean_background':
      return '- Clean the background: remove clutter, stray objects, specks, noise and compression artefacts from the background, keeping the same scene, colours and lighting. The subject, the logo and all text stay untouched.';
  }
}

/** Оговорка KEEP — ровно про то, что в запросе есть: ссылка на «указания
 *  ниже», которых нет, сбивала бы модель. */
function keepException(hasFixes: boolean, hasNotes: boolean): string {
  if (hasFixes && hasNotes) return 'unless a change under CHANGE ONLY or the moderator notes below say otherwise';
  if (hasFixes) return 'unless a change under CHANGE ONLY says otherwise';
  return 'unless the moderator notes below say otherwise';
}

function buildCarefulPrompt(params: RepairBannerImageParams): string {
  const { width, height, notes } = params;
  const aspect = pickAspectRatio(width, height);
  const crop = coverCrop(width, height);
  const margin = edgeMargin(crop);
  const fixes = REPAIR_FIXES.filter((fix) => params.fixes.includes(fix));
  const hasNotes = Boolean(notes);
  const zoneFix = fixes.includes('fit_safe_area') || fixes.includes('free_overlay_zone');

  const lines: string[] = [];
  lines.push(`Edit the attached display-ad banner. Output: ${shapeLine(width, height, aspect)}. Full-bleed, no margins or border.`);
  lines.push('');
  lines.push('REFERENCE');
  // Один баннер подгоняют под все места, и постер в полосу — основной
  // сценарий: без права переложить элементы модель либо ставила крошечный
  // постер посреди дорисованной полосы, либо перерисовывала всё сама.
  lines.push(`The attached image is the advertiser's own finished banner. Edit this banner — do not redesign it or start from scratch: the result must read as the same banner with a few precise corrections. If its shape differs from the output, extend the existing background naturally to fill the new shape — never stretch or squash anything, and never cut off text, the logo or the subject. If the shapes differ a lot, rearrange the existing elements to suit the new shape${rearrangeHint(width, height)} scaling each one evenly so text stays readable, but change nothing inside any element.`);
  if (margin) lines.push(margin.line);
  lines.push('');
  lines.push(`KEEP — exactly as in the reference, ${keepException(fixes.length > 0, hasNotes)}:`);
  lines.push('- The photo and the subject: the same product, vehicle, building, people or place, from the same angle and with the same look.');
  lines.push('- The colours and the overall style: palette, fonts, mood and the general arrangement as far as the output shape allows.');
  lines.push('- The logo and any brand marks, exactly as they appear.');
  lines.push('- All existing text and contact details, letter for letter and digit for digit: headlines, slogans, prices, phone numbers, WhatsApp and Telegram numbers, addresses, websites — same language, same spelling, same punctuation.');
  lines.push('');
  if (fixes.length === 0) {
    lines.push('CHANGE ONLY what the moderator notes below ask for.');
  } else {
    lines.push(zoneFix ? `CHANGE ONLY the following (${POSITIONS_NOTE}):` : 'CHANGE ONLY the following:');
    for (const fix of fixes) lines.push(fixLine(fix, params, crop));
    if (hasNotes) lines.push('- And whatever the moderator notes below ask for.');
  }
  lines.push('');
  lines.push('RULES');
  // Без указаний не ссылаемся на них: модель ищет блок, которого нет.
  const orNotes = hasNotes ? ' or that the moderator notes explicitly ask to be written on the banner' : '';
  lines.push(`- Do not invent anything: no text, numbers, prices, phone numbers, discounts or claims that are not already in the reference${orNotes}.`);
  // «Правильная кириллица» толкала «исправлять» абхазские буквы и намеренное
  // написание рекламодателя — это противоречит «буква в букву».
  const asWritten = hasNotes ? 'in the reference or in the wording the moderator notes give' : 'in the reference';
  lines.push(`- Never translate: all text stays in its language, every letter exactly as ${asWritten} — do not correct spelling, including Abkhaz letters such as ә, ҧ, ҭ.`);
  const cutOff = '- Never guess missing letters, words or digits of text that is cut off in the reference.';
  if (fixes.includes('restore_text')) {
    lines.push(`${cutOff} Use only the wording from the moderator notes; if they do not give it in full, remove that line completely and continue the background where it was.`);
  } else {
    const unlessNotes = hasNotes ? ', unless the moderator notes give its full wording' : '';
    lines.push(`${cutOff} If such a line has to move, move only its visible part, without completing it${unlessNotes}.`);
  }
  lines.push('- Do not add quotation marks around any text, and write each word exactly once (no word repeated across a line break).');

  if (notes) {
    lines.push('');
    lines.push(notesHeading(notes, 'KEEP'));
    lines.push(notes);
  }

  const checks = [
    `every piece of text is spelled exactly as in the reference${hasNotes ? ' or as the moderator notes ask to write it' : ''} — every letter correct, each word once, no quotation marks added`,
  ];
  if (hasNotes) checks.push('no other words from the moderator notes appear on the image');
  // Мелкий текст с цифрами drop_small_text удаляет законно — сверяем то, что осталось.
  checks.push(`every phone number and other figure that remains has exactly the same digits as in the reference${hasNotes ? ', unless the notes change it' : ''}`);
  if (margin) checks.push(margin.check);
  if (fixes.includes('fit_safe_area')) {
    checks.push(`all text and key details lie inside the area ${zoneWords(params.safeArea!, crop)}`);
  }
  if (fixes.includes('free_overlay_zone')) {
    checks.push(`the area ${zoneWords(params.reservedZone!, crop)} has no text (not even part of a line), logo or key details and looks like its surroundings`);
  }
  checks.push(`the image is ${aspect}`);
  lines.push('');
  lines.push(`Final check before you output: ${checks.join('; ')}.`);
  return lines.join('\n');
}

function toEnhanceParams(params: RepairBannerImageParams): EnhanceBannerImageParams {
  return {
    advertiserId: params.advertiserId,
    imageUrl: params.imageUrl,
    width: params.width,
    height: params.height,
    draft: params.draft,
    ctaPosition: params.ctaPosition,
  };
}

/** rebuild: промпт enhance без единой правки (его раскладку и сверку
 *  заголовка уже отладили) плюс требования модератора в конце. Своя
 *  «финальная проверка» у хвоста не заводится — пункты добавляются к
 *  проверке enhance, иначе модель видит две «последние». */
function buildRebuildPrompt(params: RepairBannerImageParams): string {
  const base = buildEnhanceBannerImagePrompt(toEnhanceParams(params));
  const { safeArea, reservedZone, notes } = params;
  if (!safeArea && !reservedZone && !notes) return base;
  const crop = coverCrop(params.width, params.height);

  const lines: string[] = [base, ''];
  const checks: string[] = [];
  if (safeArea || reservedZone) {
    lines.push(`MODERATOR REQUIREMENTS — they take priority over the layout above where they conflict (${POSITIONS_NOTE}):`);
    if (safeArea) {
      lines.push(`- The headline, any logo and the important details of the subject lie fully inside the area ${zoneWords(safeArea, crop)}; beyond it there is only background or non-essential parts of the subject.`);
      checks.push(`the headline and the important details lie inside the area ${zoneWords(safeArea, crop)}`);
    }
    if (reservedZone) {
      // Своя угловая зона enhance (по ctaPosition) и зона модератора могли
      // разойтись — модель держала бы пустыми обе. Зона модератора её заменяет.
      lines.push(`- The area ${zoneWords(reservedZone, crop)} is plain continuous background only; it looks exactly like the background beside it, with nothing placed in it, not even the end of a headline line. This area replaces the RESERVED zone in LAYOUT above and in its final check.`);
      checks.push(`the area ${zoneWords(reservedZone, crop)} is plain background identical to its surroundings`);
    }
  }
  if (notes) {
    if (safeArea || reservedZone) lines.push('');
    lines.push(notesHeading(notes, 'the instructions above'));
    lines.push(notes);
    checks.push('the moderator notes are followed', 'no other words from the moderator notes appear on the image');
  }
  lines.push('');
  lines.push(`Add to the final check above: ${checks.join('; ')}.`);
  return lines.join('\n');
}

export function buildRepairBannerImagePrompt(params: RepairBannerImageParams): string {
  return params.mode === 'rebuild' ? buildRebuildPrompt(params) : buildCarefulPrompt(params);
}
