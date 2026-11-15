import { describe, expect, it } from 'vitest';
import { looseHash, splitLines, strictHash } from '../../src/store/hash';

describe('strictHash', () => {
  it('is 12 hex characters', () => {
    expect(strictHash('const a = 1;')).toMatch(/^[0-9a-f]{12}$/);
  });

  it('ignores CRLF and trailing whitespace', () => {
    expect(strictHash('  foo();\r')).toBe(strictHash('  foo();'));
    expect(strictHash('  foo();  \t')).toBe(strictHash('  foo();'));
  });

  it('is sensitive to indentation and content', () => {
    expect(strictHash('  foo();')).not.toBe(strictHash('    foo();'));
    expect(strictHash('foo();')).not.toBe(strictHash('bar();'));
  });
});

describe('looseHash', () => {
  it('survives re-indentation and spacing changes', () => {
    expect(looseHash('  if (a) {')).toBe(looseHash('\t\tif (a) {'));
    expect(looseHash('const a=1;')).toBe(looseHash('const a = 1;'));
  });

  it('still distinguishes different content', () => {
    expect(looseHash('foo();')).not.toBe(looseHash('bar();'));
  });
});

describe('splitLines', () => {
  it('does not add an empty line for a trailing newline', () => {
    expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('')).toEqual([]);
  });

  it('keeps interior blank lines', () => {
    expect(splitLines('a\n\nb')).toEqual(['a', '', 'b']);
  });
});
