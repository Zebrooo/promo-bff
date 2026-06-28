/**
 * Транскод сгенерённого моделью баннера (часто PNG ~1.3 МБ) в компактный WebP,
 * вписанный РОВНО в целевой слот W×H умным кропом (sharp attention — фокус на
 * содержимом, не центр вслепую). Зачем:
 *   - убирает пересылку мегабайтного base64 data-URL на витрину;
 *   - гарантирует webp в storage (витрина грузит его напрямую);
 *   - подгоняет кадр под пропорции слота.
 *
 * sharp импортируется ЛЕНИВО (dynamic import внутри функции): сервис стартует и
 * работает даже если sharp не установлен/не загрузился — на любой ошибке
 * возвращаем исходный data-URL как есть (модель уже отдала валидную картинку).
 */
const DATA_URL_RE = /^data:image\/([a-z0-9+.-]+);base64,(.+)$/i;

export async function transcodeBannerToWebp(
  dataUrl: string,
  width: number,
  height: number,
  quality = 80,
): Promise<string> {
  try {
    const m = DATA_URL_RE.exec(dataUrl);
    if (!m) return dataUrl;
    const { default: sharp } = await import('sharp');
    const input = Buffer.from(m[2], 'base64');
    const out = await sharp(input, { failOn: 'none' })
      .resize(Math.round(width), Math.round(height), {
        fit: 'cover',
        position: sharp.strategy.attention,
      })
      .webp({ quality })
      .toBuffer();
    return `data:image/webp;base64,${out.toString('base64')}`;
  } catch {
    return dataUrl; // sharp отсутствует/ошибка → passthrough, сервис не падает
  }
}
