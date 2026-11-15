import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/adapters/claudeCode';
import { changesFromNewFile, changesFromPatch, changesFromSearch } from '../../src/capture/lineRanges';
import { looseHash, strictHash } from '../../src/store/hash';

// Real payloads captured from Claude Code 2.1.325.
function fixture(name: string) {
  const file = path.resolve(__dirname, '../fixtures/hook-payloads', `${name}.json`);
  const event = claudeCode.parseEditPayload(JSON.parse(readFileSync(file, 'utf8')));
  if (!event) throw new Error(`fixture ${name} did not parse`);
  return event;
}

describe('changesFromPatch (real payloads)', () => {
  it('Edit: one line replaced by two', () => {
    // alpha / beta / gamma  →  alpha / BETA / BETA2 / gamma
    const changes = changesFromPatch(fixture('PostToolUse-Edit').patch!);
    expect(changes.hunks).toEqual([
      {
        start: 2,
        end: 3,
        hashes: [strictHash('BETA'), strictHash('BETA2')],
        loose: [looseHash('BETA'), looseHash('BETA2')],
      },
    ]);
    expect(changes.removed_hashes).toEqual([strictHash('beta')]);
  });

  it('Edit with replace_all: one hunk per occurrence', () => {
    // one / two / three / two  →  one / TWO / three / TWO
    const changes = changesFromPatch(fixture('PostToolUse-Edit-replaceAll').patch!);
    expect(changes.hunks.map((h) => [h.start, h.end])).toEqual([
      [2, 2],
      [4, 4],
    ]);
    expect(changes.hunks.every((h) => h.hashes[0] === strictHash('TWO'))).toBe(true);
    expect(changes.removed_hashes).toEqual([strictHash('two'), strictHash('two')]);
  });

  it('Write over an existing file: only the changed line is attributed', () => {
    // alpha / BETA / BETA2 / gamma  →  alpha / BETA / BETA2 / delta
    const changes = changesFromPatch(fixture('PostToolUse-Write-update').patch!);
    expect(changes.hunks).toEqual([
      { start: 4, end: 4, hashes: [strictHash('delta')], loose: [looseHash('delta')] },
    ]);
    expect(changes.removed_hashes).toEqual([strictHash('gamma')]);
  });

  it('ignores the "no newline at end of file" marker', () => {
    const changes = changesFromPatch([
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '\\ No newline at end of file', '+b'] },
    ]);
    expect(changes.hunks).toEqual([{ start: 1, end: 1, hashes: [strictHash('b')], loose: [looseHash('b')] }]);
  });
});

describe('changesFromNewFile', () => {
  it('Write creating a file: every line, from line 1', () => {
    const event = fixture('PostToolUse-Write-create');
    expect(event.patch).toBeUndefined();
    const changes = changesFromNewFile(event.created_content!);
    expect(changes.hunks).toHaveLength(1);
    expect(changes.hunks[0]).toMatchObject({ start: 1, end: 3 });
    expect(changes.hunks[0].hashes).toEqual(['alpha', 'beta', 'gamma'].map(strictHash));
  });

  it('an empty file writes nothing', () => {
    expect(changesFromNewFile('').hunks).toEqual([]);
  });
});

describe('changesFromSearch (fallback when the payload has no patch)', () => {
  const file = 'one\nTWO\nthree\nTWO\n';

  it('finds the first occurrence', () => {
    const changes = changesFromSearch(file, 'two', 'TWO', false);
    expect(changes.hunks.map((h) => [h.start, h.end])).toEqual([[2, 2]]);
    expect(changes.removed_hashes).toEqual([strictHash('two')]);
  });

  it('finds every occurrence with replace_all', () => {
    const changes = changesFromSearch(file, 'two', 'TWO', true);
    expect(changes.hunks.map((h) => h.start)).toEqual([2, 4]);
  });

  it('handles multi-line replacements', () => {
    const changes = changesFromSearch('a\nx\ny\nb\n', 'old', 'x\ny', false);
    expect(changes.hunks[0]).toMatchObject({ start: 2, end: 3 });
  });

  it('records no hunk when the text is not in the file', () => {
    expect(changesFromSearch(file, 'two', 'missing', false).hunks).toEqual([]);
  });
});
