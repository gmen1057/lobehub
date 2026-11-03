import { describe, expect, it } from 'vitest';

import { sanitizeBm25Query } from './bm25';

describe('sanitizeBm25Query', () => {
  it('should lowercase and join multiple words with AND', () => {
    expect(sanitizeBm25Query('Hello World')).toBe('hello AND world');
  });

  it('should return single word lowercased', () => {
    expect(sanitizeBm25Query('Hello')).toBe('hello');
  });

  it('should strip non-letter/digit punctuation and drop 1-char terms', () => {
    expect(sanitizeBm25Query('hello+world')).toBe('hello AND world');
    expect(sanitizeBm25Query('a-b')).toBe('');
    expect(sanitizeBm25Query('a&b|c')).toBe('');
    expect(sanitizeBm25Query('a &b| c')).toBe('');
    expect(sanitizeBm25Query('test!')).toBe('test');
    expect(sanitizeBm25Query('(group)')).toBe('group');
    expect(sanitizeBm25Query('{curly}')).toBe('curly');
    expect(sanitizeBm25Query('[bracket]')).toBe('bracket');
    expect(sanitizeBm25Query('foo^bar')).toBe('foo AND bar');
    expect(sanitizeBm25Query('"quoted"')).toBe('quoted');
    expect(sanitizeBm25Query('~fuzzy')).toBe('fuzzy');
    expect(sanitizeBm25Query('wild*card')).toBe('wild AND card');
    expect(sanitizeBm25Query('single?char')).toBe('single AND char');
    expect(sanitizeBm25Query('field:value')).toBe('field AND value');
    expect(sanitizeBm25Query('back\\slash')).toBe('back AND slash');
    expect(sanitizeBm25Query('foo/bar')).toBe('foo AND bar');
  });

  it('should strip multiple special characters, drop 1-char terms, and join remaining with AND', () => {
    expect(sanitizeBm25Query('(foo+b) & bar!')).toBe('foo AND bar');
    expect(sanitizeBm25Query('react-component')).toBe('react AND component');
  });

  it('should cap total terms at 32', () => {
    const fortyTerms = Array.from({ length: 40 }, (_, i) => `term${i + 1}`).join(' ');
    const sanitized = sanitizeBm25Query(fortyTerms);
    const parts = sanitized.split(' AND ');
    expect(parts).toHaveLength(32);
    expect(parts[0]).toBe('term1');
    expect(parts[31]).toBe('term32');
  });

  it('should trim whitespace', () => {
    expect(sanitizeBm25Query('  hello  ')).toBe('hello');
    expect(sanitizeBm25Query('  hello world  ')).toBe('hello AND world');
  });

  it('should return empty string on empty, whitespace-only, or punctuation-only input', () => {
    expect(sanitizeBm25Query('')).toBe('');
    expect(sanitizeBm25Query('   ')).toBe('');
    expect(sanitizeBm25Query('!@#$%^&*()_+-=[]{}|;:\'",.<>?/`~\\')).toBe('');
  });

  it('should handle CJK characters', () => {
    expect(sanitizeBm25Query('你好世界')).toBe('你好世界');
    expect(sanitizeBm25Query('こんにちは')).toBe('こんにちは');
  });
});
