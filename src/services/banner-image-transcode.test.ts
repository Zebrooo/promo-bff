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

  it('fails closed for malformed image data', async () => {
    await expect(transcodeBannerToWebp('data:image/png;base64,bm90LWltYWdl', 1200, 150))
      .resolves.toBeNull();
    await expect(transcodeBannerToWebp('not-a-data-url', 1200, 150))
      .resolves.toBeNull();
  });
});
