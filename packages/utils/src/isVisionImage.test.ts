import { describe, expect, it } from 'vitest';

import {
  isLargeSvg,
  isSvgFileName,
  isSvgMime,
  isVisionImageMime,
  SVG_LARGE_THRESHOLD_BYTES,
} from './isVisionImage';

describe('isSvgMime', () => {
  it('detects svg mime types', () => {
    expect(isSvgMime('image/svg+xml')).toBe(true);
    expect(isSvgMime('image/svg')).toBe(true);
    expect(isSvgMime('image/svg+xml; charset=utf-8')).toBe(true);
  });

  it('rejects non-svg', () => {
    expect(isSvgMime('image/png')).toBe(false);
    expect(isSvgMime('text/plain')).toBe(false);
    expect(isSvgMime(null)).toBe(false);
  });
});

describe('isVisionImageMime', () => {
  it('allows raster images', () => {
    expect(isVisionImageMime('image/png')).toBe(true);
    expect(isVisionImageMime('image/jpeg')).toBe(true);
    expect(isVisionImageMime('image/webp')).toBe(true);
    expect(isVisionImageMime('image/gif')).toBe(true);
  });

  it('excludes svg', () => {
    expect(isVisionImageMime('image/svg+xml')).toBe(false);
  });

  it('excludes non-images', () => {
    expect(isVisionImageMime('application/pdf')).toBe(false);
  });
});

describe('isSvgFileName / isLargeSvg', () => {
  it('detects .svg extension', () => {
    expect(isSvgFileName('logo.svg')).toBe(true);
    expect(isSvgFileName('LOGO.SVG')).toBe(true);
    expect(isSvgFileName('logo.png')).toBe(false);
  });

  it('flags large svgs', () => {
    expect(isLargeSvg(SVG_LARGE_THRESHOLD_BYTES)).toBe(false);
    expect(isLargeSvg(SVG_LARGE_THRESHOLD_BYTES + 1)).toBe(true);
  });
});
