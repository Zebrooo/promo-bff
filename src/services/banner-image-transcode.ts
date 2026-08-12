/**
 * Транскод сгенерённого моделью баннера (часто PNG ~1.3 МБ) в компактный WebP,
 * вписанный РОВНО в целевой слот W×H умным кропом (sharp attention — фокус на
 * содержимом, не центр вслепую). Зачем:
 *   - убирает пересылку мегабайтного base64 data-URL на витрину;
 *   - гарантирует webp в storage (витрина грузит его напрямую);
 *   - подгоняет кадр под пропорции слота.
 *
 * sharp импортируется ЛЕНИВО (dynamic import внутри функции). Ошибка обработки
 * возвращает null: downstream не вправе помечать исходник модели как точный
 * W×H-вариант, иначе аукцион выберет его по ложным метаданным и снова обрежет.
 */
const DATA_URL_RE = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i;

export async function transcodeBannerToWebp(
  dataUrl: string,
  width: number,
  height: number,
  quality = 80,
): Promise<string | null> {
  try {
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return null;
    const { default: sharp } = await import('sharp');
    const input = Buffer.from(m[2], 'base64');
    const targetWidth = Math.round(width);
    const targetHeight = Math.round(height);
    const { data: out, info } = await sharp(input, { failOn: 'none' })
      .resize(Math.round(width), Math.round(height), {
        fit: 'cover',
        position: sharp.strategy.attention,
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });
    if (info.width !== targetWidth || info.height !== targetHeight || info.format !== 'webp') return null;
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch {
    return null;
  }
}
