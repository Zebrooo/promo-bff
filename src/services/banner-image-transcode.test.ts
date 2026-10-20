import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { transcodeBannerToWebp } from './banner-image-transcode';

describe('transcodeBannerToWebp', () => {
  it('returns an exact WebP at the requested dimensions', async () => {
    const input = await sharp({
      create: { width: 64, height: 64, channels: 3, background: '#cf3635' },
    }).png().toBuffer();

    const result = await transcodeBannerToWebp(
      `data:image/png;base64,${input.toString('base64')}`,
      580,
      120,
    );

    expect(result).toMatch(/^data:image\/webp;base64,/);
    const output = Buffer.from(result!.split(',')[1]!, 'base64');
    await expect(sharp(output).metadata()).resolves.toMatchObject({
      format: 'webp',
      width: 580,
      height: 120,
    });
  });

  it('кроп: по умолчанию по содержимому (attention), centre — поровну с обеих сторон', async () => {
    // Полоса 40×10: левый квадрат ярко-красный, остальное серое. В 10×10
    // attention тянется к красному, центр берёт серую середину.
    const red = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const input = await sharp({ create: { width: 40, height: 10, channels: 3, background: '#808080' } })
      .composite([{ input: red, left: 0, top: 0 }])
      .png()
      .toBuffer();
    const dataUrl = `data:image/png;base64,${input.toString('base64')}`;
    /** Средний перевес красного над зелёным: ≈255 у красного, ≈0 у серого. */
    const redness = async (result: string | null) => {
      const { data, info } = await sharp(Buffer.from(result!.split(',')[1]!, 'base64'))
        .raw()
        .toBuffer({ resolveWithObject: true });
      let sum = 0;
      for (let i = 0; i < data.length; i += info.channels) sum += data[i]! - data[i + 1]!;
      return sum / (data.length / info.channels);
    };

    expect(await redness(await transcodeBannerToWebp(dataUrl, 10, 10))).toBeGreaterThan(200);
    expect(await redness(await transcodeBannerToWebp(dataUrl, 10, 10, { crop: 'centre' }))).toBeLessThan(20);
  });

  it('fails closed for malformed image data', async () => {
    await expect(transcodeBannerToWebp('data:image/png;base64,bm90LWltYWdl', 1200, 150))
      .resolves.toBeNull();
    await expect(transcodeBannerToWebp('not-a-data-url', 1200, 150))
      .resolves.toBeNull();
  });
});
