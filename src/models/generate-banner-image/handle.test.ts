import { describe, it, expect } from 'vitest';
import { buildGenerateBannerImagePrompt } from './handle';

describe('buildGenerateBannerImagePrompt', () => {
  it('бриф попадает дословно, форма названа, текста на картинке быть не должно', () => {
    const prompt = buildGenerateBannerImagePrompt({
      advertiserId: 'a', prompt: 'летний попап для гостиницы в Гагре', width: 600, height: 750,
    });
    expect(prompt).toContain('летний попап для гостиницы в Гагре');
    expect(prompt).toContain('a vertical poster, aspect ratio 4:5');
    expect(prompt).toContain('carries no text at all');
    expect(prompt).toContain('the lower 40 % of the height');
  });

  it('полоса — спокойная зона справа', () => {
    const prompt = buildGenerateBannerImagePrompt({ advertiserId: 'a', prompt: 'море', width: 2400, height: 300 });
    expect(prompt).toContain('a very wide horizontal strip, aspect ratio 8:1');
    expect(prompt).toContain('the right 40 % of the width');
  });
});
