import { describe, it, expect } from 'vitest';
import { bannerShape, pickAspectRatio } from './banner-aspect';

describe('pickAspectRatio', () => {
  it('полоса рекламодателя (2400×300, 1200×150) — ровно 8:1', () => {
    expect(pickAspectRatio(2400, 300)).toBe('8:1');
    expect(pickAspectRatio(1200, 150)).toBe('8:1');
  });

  it('телефонная полоса 1160×240 (4,83:1) ближе к 4:1, чем к 8:1', () => {
    expect(pickAspectRatio(1160, 240)).toBe('4:1');
    expect(pickAspectRatio(580, 120)).toBe('4:1');
  });

  it('блок 600×750 — точное 4:5, вертикаль 600×1000 — 9:16', () => {
    expect(pickAspectRatio(600, 750)).toBe('4:5');
    expect(pickAspectRatio(600, 1000)).toBe('9:16');
  });

  it('квадрат и штатные размеры модели возвращаются как есть', () => {
    expect(pickAspectRatio(1024, 1024)).toBe('1:1');
    expect(pickAspectRatio(1536, 672)).toBe('21:9');
    expect(pickAspectRatio(1344, 768)).toBe('16:9');
    expect(pickAspectRatio(768, 1344)).toBe('9:16');
  });

  it('расстояние симметрично: в полтора раза шире и в полтора раза уже 1:1 дают соседей, а не 1:1', () => {
    // 1.5:1 лежит между 4:3 (1.33) и 3:2 (1.5) — ровно 3:2; 1:1.5 — ровно 2:3.
    expect(pickAspectRatio(1500, 1000)).toBe('3:2');
    expect(pickAspectRatio(1000, 1500)).toBe('2:3');
  });
});

describe('bannerShape', () => {
  it('полоса — от 2,5:1, как short у витрины', () => {
    expect(bannerShape(2400, 300)).toBe('strip');
    expect(bannerShape(1160, 240)).toBe('strip');
    expect(bannerShape(500, 200)).toBe('strip');
    expect(bannerShape(499, 200)).toBe('landscape');
  });

  it('блок и вертикаль — портрет, попап 16:9 — ландшафт, около 1:1 — квадрат', () => {
    expect(bannerShape(600, 750)).toBe('portrait');
    expect(bannerShape(600, 1000)).toBe('portrait');
    expect(bannerShape(1344, 768)).toBe('landscape');
    expect(bannerShape(1000, 1000)).toBe('square');
    expect(bannerShape(1100, 1000)).toBe('square');
    expect(bannerShape(1000, 1100)).toBe('square');
  });
});
