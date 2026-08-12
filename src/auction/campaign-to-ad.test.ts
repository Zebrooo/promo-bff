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
      imageVariants: {
        wide: { imageUrl: 'https://x/wide.png', width: 1200, height: 150 },
        compact: { imageUrl: 'https://x/compact.png', width: 580, height: 120 },
      },
      }),
      bannerFormat: 'horizontal',
    };

    const wide = campaignToAd(candidate, { width: 820, height: 96 });
    const compact = campaignToAd(candidate, { width: 580, height: 120 });

    expect(wide?.imageUrl).toBe('https://x/wide.png');
    expect(compact?.imageUrl).toBe('https://x/compact.png');
    expect(wide).not.toHaveProperty('imageVariants');
    expect(compact).not.toHaveProperty('imageVariants');
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

  it('returns null when title is missing or blank', () => {
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
