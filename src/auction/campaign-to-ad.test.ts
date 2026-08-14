import { describe, expect, it } from 'vitest';
import { campaignToAd } from './campaign-to-ad';
import type { CampaignCandidate } from '../services/campaign-service';

function cand(creative: unknown): CampaignCandidate {
  return { id: 42, advertiserId: 'adv-1', cpmKopecks: 5000, creative, spentKopecks: 0, totalBudgetKopecks: null, targetPages: null, bannerFormat: null };
}

describe('campaignToAd', () => {
  it('namespaces the id and copies known creative fields', () => {
    const ad = campaignToAd(cand({
      format: 'popup',
      title: 'Sale',
      description: '30% off',
      imageUrl: 'https://x/y.png',
      imageFocalPoint: { xBp: 2500, yBp: 7500 },
      action: { href: '/sale', label: 'Go' },
      backgroundColor: '#fff',
      textColor: '#000',
      backgroundImage: 'https://x/bg.png',
      dismissible: true,
    }));
    expect(ad).toEqual({
      id: 'campaign:42',
      format: 'popup',
      title: 'Sale',
      description: '30% off',
      imageUrl: 'https://x/y.png',
      imageFocalPoint: { xBp: 2500, yBp: 7500 },
      action: { href: '/sale', label: 'Go' },
      backgroundColor: '#fff',
      textColor: '#000',
      backgroundImage: 'https://x/bg.png',
      dismissible: true,
    });
  });

  it('omits absent optional fields and ignores unknown keys', () => {
    const ad = campaignToAd(cand({ format: 'topline', title: 'Hi', bogus: 'x' }));
    expect(ad).toEqual({ id: 'campaign:42', format: 'topline', title: 'Hi' });
  });

  it('returns null when format is missing or not a known PromoFormat', () => {
    expect(campaignToAd(cand({ title: 'Hi' }))).toBeNull();
    expect(campaignToAd(cand({ format: 'video', title: 'Hi' }))).toBeNull();
  });

  it('builds a banner ad from a banner creative (title + image + action)', () => {
    const ad = campaignToAd(cand({ format: 'banner', title: 'Buy', imageUrl: 'https://x/b.png', action: { href: 'https://shop', label: 'Go' } }));
    expect(ad).not.toBeNull();
    expect(ad!.format).toBe('banner');
    expect(ad!.id).toBe('campaign:42');
    expect(ad!.imageUrl).toBe('https://x/b.png');
    expect(ad!.action).toEqual({ href: 'https://shop', label: 'Go' });
  });

  it('selects one closest-aspect image for the requested slot without exposing variants', () => {
    const candidate = {
      ...cand({
      format: 'banner',
      title: 'Buy',
      imageUrl: 'https://x/legacy.png',
      imageFocalPoint: { xBp: 5000, yBp: 5000 },
      imageVariants: {
        wide: {
          imageUrl: 'https://x/wide.png',
          width: 1200,
          height: 150,
          focalPoint: { xBp: 1000, yBp: 2000 },
        },
        compact: {
          imageUrl: 'https://x/compact.png',
          width: 580,
          height: 120,
          focalPoint: { xBp: 8000, yBp: 7000 },
        },
      },
      }),
      bannerFormat: 'horizontal',
    };

    const wide = campaignToAd(candidate, { width: 820, height: 96 });
    const compact = campaignToAd(candidate, { width: 580, height: 120 });

    expect(wide?.imageUrl).toBe('https://x/wide.png');
    expect(compact?.imageUrl).toBe('https://x/compact.png');
    expect(wide?.imageFocalPoint).toEqual({ xBp: 1000, yBp: 2000 });
    expect(compact?.imageFocalPoint).toEqual({ xBp: 8000, yBp: 7000 });
    expect(wide).not.toHaveProperty('imageVariants');
    expect(compact).not.toHaveProperty('imageVariants');
  });

  it('omits malformed variant focal metadata without changing the selected image', () => {
    const candidate = {
      ...cand({
        format: 'banner',
        title: 'Buy',
        imageUrl: 'https://x/legacy.png',
        imageFocalPoint: { xBp: 2500, yBp: 7500 },
        imageVariants: {
          wide: {
            imageUrl: 'https://x/wide.png',
            width: 1200,
            height: 150,
            focalPoint: { xBp: 5000 },
          },
          compact: {
            imageUrl: 'https://x/compact.png',
            width: 580,
            height: 120,
            focalPoint: { xBp: 8000, yBp: 7000 },
          },
        },
      }),
      bannerFormat: 'horizontal',
    };

    const wide = campaignToAd(candidate, { width: 1200, height: 150 });

    expect(wide?.imageUrl).toBe('https://x/wide.png');
    expect(wide).not.toHaveProperty('imageFocalPoint');
    expect(wide).not.toHaveProperty('imageVariants');
  });

  it('accepts integer focal bounds and omits invalid primary focal metadata', () => {
    const project = (imageFocalPoint: unknown) => campaignToAd(cand({
      format: 'banner',
      title: 'Buy',
      imageUrl: 'https://x/legacy.png',
      imageFocalPoint,
    }));

    expect(project({ xBp: 0, yBp: 10_000 })?.imageFocalPoint).toEqual({ xBp: 0, yBp: 10_000 });
    for (const invalid of [
      { xBp: -1, yBp: 5000 },
      { xBp: 5000.5, yBp: 5000 },
      { xBp: 5000, yBp: 10_001 },
      { xBp: 5000 },
    ]) {
      const ad = project(invalid);
      expect(ad?.imageUrl).toBe('https://x/legacy.png');
      expect(ad).not.toHaveProperty('imageFocalPoint');
    }
  });

  it('falls back to the canonical image for legacy requests or a malformed variant pair', () => {
    const partial = {
      format: 'banner',
      title: 'Buy',
      imageUrl: 'https://x/legacy.png',
      imageVariants: {
        wide: { imageUrl: 'https://x/wide.png', width: 1200, height: 150 },
      },
    };
    const malformed = {
      ...partial,
      imageVariants: {
        wide: { imageUrl: 'https://x/wide.png', width: 0, height: 150 },
        compact: { imageUrl: 'https://x/compact.png', width: 580, height: 120 },
      },
    };

    const horizontalPartial = { ...cand(partial), bannerFormat: 'horizontal' };
    const horizontalMalformed = { ...cand(malformed), bannerFormat: 'horizontal' };
    expect(campaignToAd(horizontalPartial)?.imageUrl).toBe('https://x/legacy.png');
    expect(campaignToAd(horizontalPartial, { width: 580, height: 120 })?.imageUrl).toBe('https://x/legacy.png');
    expect(campaignToAd(horizontalMalformed, { width: 580, height: 120 })?.imageUrl).toBe('https://x/legacy.png');
  });

  it('ignores adaptive image metadata on a non-horizontal banner', () => {
    const candidate = cand({
      format: 'banner',
      title: 'Buy',
      imageUrl: 'https://x/legacy.png',
      imageVariants: {
        wide: { imageUrl: 'https://x/wide.png', width: 1200, height: 150 },
        compact: { imageUrl: 'https://x/compact.png', width: 580, height: 120 },
      },
    });

    expect(campaignToAd(candidate, { width: 580, height: 120 })?.imageUrl).toBe('https://x/legacy.png');
  });

  it('serves a self-serve banner with an omitted or blank title', () => {
    const creative = {
      format: 'banner',
      imageUrl: 'https://x/banner.png',
      action: { href: 'https://shop' },
    };

    expect(campaignToAd(cand(creative))).toEqual({
      id: 'campaign:42',
      format: 'banner',
      title: '',
      imageUrl: 'https://x/banner.png',
      action: { href: 'https://shop' },
    });
    expect(campaignToAd(cand({ ...creative, title: '   ' }))?.title).toBe('');
  });

  it('rejects a titleless banner without its required image or destination', () => {
    expect(campaignToAd(cand({ format: 'banner' }))).toBeNull();
    expect(campaignToAd(cand({ format: 'banner', imageUrl: 'https://x/banner.png' }))).toBeNull();
    expect(campaignToAd(cand({ format: 'banner', action: { href: 'https://shop' } }))).toBeNull();
  });

  it('still returns null when a legacy creative title is missing or blank', () => {
    expect(campaignToAd(cand({ format: 'popup' }))).toBeNull();
    expect(campaignToAd(cand({ format: 'popup', title: '   ' }))).toBeNull();
  });

  it('returns null when creative is not an object', () => {
    expect(campaignToAd(cand(null))).toBeNull();
    expect(campaignToAd(cand('nope'))).toBeNull();
  });

  it('drops a malformed action (missing href)', () => {
    const ad = campaignToAd(cand({ format: 'popup', title: 'Hi', action: { label: 'no href' } }));
    expect(ad).toEqual({ id: 'campaign:42', format: 'popup', title: 'Hi' });
  });
});
