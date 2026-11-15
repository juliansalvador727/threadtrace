import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode, subagentTranscriptPath } from '../../src/adapters/claudeCode';
import { blameLines, parsePorcelain } from '../../src/git/blame';
import { Git } from '../../src/git/exec';
import { similarity } from '../../src/resolve/fuzzy';
import { isWeak } from '../../src/resolve/weakLines';
import { looseHash, strictHash } from '../../src/store/hash';
import { TraceStore } from '../../src/store/traceStore';
import { MINUTE, SESSION, T0, TestRepo } from './helpers/repo';

let repo: TestRepo;
beforeEach(() => {
  repo = new TestRepo();
});
afterEach(() => repo.dispose());

describe('TraceStore', () => {
  it('is empty when the records folder does not exist', () => {
    const store = new TraceStore(repo.records);
    expect(store.refresh()).toBe(false);
    expect(store.editCount).toBe(0);
    expect(store.strict('a.ts', strictHash('x'))).toEqual([]);
  });

  it('indexes edits by file and by strict and loose hash, and turns by id', () => {
    repo.addTurn({ id: `${SESSION}:p1`, prompt: 'hello' });
    const edit = repo.addEdit({ file: 'a.ts', start: 3, lines: ['  foo();', '  bar();'], ts: T0 });
    const store = new TraceStore(repo.records);
    expect(store.refresh()).toBe(true);
    expect(store.strict('a.ts', strictHash('  foo();'))).toEqual([edit]);
    expect(store.strict('b.ts', strictHash('  foo();'))).toEqual([]);
    expect(store.strict('a.ts', strictHash('foo();'))).toEqual([]);
    expect(store.loose('a.ts', looseHash('foo( );'))).toEqual([edit]);
    expect(store.turn(`${SESSION}:p1`)?.prompt).toBe('hello');
  });

  it('reads file names that need JSON escaping', () => {
    const file = 'dir/we"ird \\ näme.ts';
    const edit = repo.addEdit({ file, start: 1, lines: ['foo();'], ts: T0 });
    const store = new TraceStore(repo.records);
    store.refresh();
    expect(store.strict(file, strictHash('foo();'))).toEqual([edit]);
  });

  it('finds the store through the repo, like the hook does', () => {
    repo.addEdit({ file: 'a.ts', start: 1, lines: ['foo();'], ts: T0 });
    mkdirSync(path.join(repo.root, 'deep/dir'), { recursive: true });
    const store = TraceStore.forRepo(path.join(repo.root, 'deep/dir'));
    store?.refresh();
    expect(store?.editCount).toBe(1);
  });

  it('picks up appended records and waits for a half-written line', () => {
    repo.addEdit({ file: 'a.ts', start: 1, lines: ['foo();'], ts: T0 });
    const store = new TraceStore(repo.records);
    store.refresh();
    expect(store.refresh()).toBe(false);

    const second = repo.addEdit({ file: 'a.ts', start: 2, lines: ['bar();'], ts: T0 + MINUTE });
    const third = JSON.stringify({ ...second, id: 'THIRD', hunks: [{ hashes: [strictHash('baz();')] }] });
    const edits = path.join(repo.records, 'edits.jsonl');
    appendFileSync(edits, third.slice(0, 40));
    expect(store.refresh()).toBe(true);
    expect(store.editCount).toBe(2);
    expect(store.strict('a.ts', strictHash('bar();'))).toHaveLength(1);

    appendFileSync(edits, third.slice(40) + '\n');
    expect(store.refresh()).toBe(true);
    expect(store.strict('a.ts', strictHash('baz();'))[0].id).toBe('THIRD');
  });

  it('skips lines that are not records and starts over when the file is replaced', () => {
    repo.addEdit({ file: 'a.ts', start: 1, lines: ['foo();'], ts: T0 });
    const edits = path.join(repo.records, 'edits.jsonl');
    appendFileSync(edits, 'not json\n{"v":1}\n{"v":1,"id":"X","file":"a.ts","hunks":"broken"}\n{"file":"a.ts", cut off\n');
    const store = new TraceStore(repo.records);
    store.refresh();
    expect(store.strict('a.ts', strictHash('foo();'))).toHaveLength(1);

    rmSync(edits);
    store.refresh();
    expect(store.editCount).toBe(0);
    expect(store.strict('a.ts', strictHash('foo();'))).toEqual([]);
  });

  it('notifies listeners when the records change on disk', async () => {
    repo.addEdit({ file: 'a.ts', start: 1, lines: ['foo();'], ts: T0 });
    const store = new TraceStore(repo.records);
    store.refresh();
    const changed = new Promise<void>((resolve) => store.onDidChange(resolve));
    repo.addEdit({ file: 'a.ts', start: 2, lines: ['bar();'], ts: T0 });
    await changed;
    expect(store.editCount).toBe(2);
    store.dispose();
  });
});

describe('blame', () => {
  it('parses porcelain output, reusing commit fields for later lines', () => {
    const sha = 'a'.repeat(40);
    const output = [
      `${sha} 7 1 2`,
      'author Dana Q',
      'author-mail <dana@example.com>',
      'author-time 1700000000',
      'author-tz +0000',
      'committer Julian',
      'committer-mail <julian@example.com>',
      'committer-time 1700000500',
      'committer-tz +0000',
      'summary Add things: part 1',
      `previous ${'b'.repeat(40)} old name.ts`,
      'filename old name.ts',
      '\tfirst',
      `${sha} 8 2`,
      '\tauthor not a header',
      `${'0'.repeat(40)} 3 3 1`,
      'author External file (--contents)',
      'filename new.ts',
      '\tthird',
      '',
    ].join('\n');
    const lines = parsePorcelain(output);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      line: 1,
      sha,
      committed: true,
      origLine: 7,
      origPath: 'old name.ts',
      author: 'Dana Q',
      authorTime: 1700000000,
      committerTime: 1700000500,
      summary: 'Add things: part 1',
      previous: { sha: 'b'.repeat(40), path: 'old name.ts' },
    });
    expect(lines[1]).toMatchObject({ line: 2, origLine: 8, author: 'Dana Q', origPath: 'old name.ts' });
    expect(lines[2]).toMatchObject({ line: 3, committed: false });
  });

  it('blames the given contents, not the file on disk', async () => {
    repo.write('a.txt', 'one\ntwo\n');
    const sha = repo.commit('first', T0);
    const lines = await blameLines(new Git(repo.root), 'a.txt', 1, 3, 'one\nnew\ntwo\n');
    expect(lines.map((line) => line.committed)).toEqual([true, false, true]);
    expect(lines[2]).toMatchObject({ sha, origLine: 2, summary: 'first', author: 'Julian' });
  });

  it('follows a rename to the original path', async () => {
    repo.write('old.txt', 'one\ntwo\nthree\n');
    repo.commit('first', T0);
    repo.git('mv', 'old.txt', 'new.txt');
    repo.commit('rename', T0 + MINUTE);
    const [line] = await blameLines(new Git(repo.root), 'new.txt', 2, 2, repo.read('new.txt'));
    expect(line).toMatchObject({ origPath: 'old.txt', summary: 'first' });
  });

  it('treats an untracked file as uncommitted', async () => {
    repo.write('a.txt', 'one\n');
    repo.commit('first', T0);
    const lines = await blameLines(new Git(repo.root), 'untracked.txt', 1, 2, 'x\ny\n');
    expect(lines.map((line) => [line.line, line.committed])).toEqual([
      [1, false],
      [2, false],
    ]);
  });

  it('throws when git itself fails', async () => {
    await expect(blameLines(new Git(repo.root, 'git-does-not-exist'), 'a.txt', 1, 1, 'x\n')).rejects.toThrow(/git blame failed/);
  });
});

describe('weak lines', () => {
  it.each(['', '   ', '}', '});', '  ],', '{', '*/', '} else {', 'else:', 'end', 'return;', 'break;', '  pass', '} finally {'])(
    'treats %j as weak',
    (line) => expect(isWeak(line)).toBe(true),
  );
  it.each(['return total;', 'x', 'i++;', 'const a = 1;', '] as const;', 'else if (ready) {', 'café'])('treats %j as strong', (line) =>
    expect(isWeak(line)).toBe(false),
  );
});

describe('similarity', () => {
  it('is 1 for equal lines, ignoring indentation', () => {
    expect(similarity('  foo(bar);', 'foo(bar);')).toBe(1);
  });
  it('is high for a renamed variable and low for unrelated lines', () => {
    expect(similarity('const total = price * quantity;', 'const sum = price * quantity;')).toBeGreaterThanOrEqual(0.75);
    expect(similarity('const total = price * quantity;', 'import * as fs from "node:fs";')).toBeLessThan(0.5);
  });
  it('handles empty and very long lines', () => {
    expect(similarity('', '')).toBe(1);
    expect(similarity('abc', '')).toBe(0);
    expect(similarity('a'.repeat(2000), 'b'.repeat(2000))).toBe(0);
  });
});

describe('claudeCode.modelForEdit', () => {
  const assistant = (model: string, id: string) =>
    JSON.stringify({ type: 'assistant', message: { model, content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id, name: 'Edit', input: {} }] } }) + '\n';
  let transcript: string;
  beforeEach(() => {
    transcript = path.join(repo.tmp, 'projects', `${SESSION}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
  });

  it('returns the model of the message that made the tool call', () => {
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'user', message: { content: 'mentions "tool_use" and "assistant"' } }) +
        '\n' +
        assistant('claude-opus-5-5', 'toolu_a') +
        'not json "tool_use" "assistant"\n' +
        assistant('claude-haiku-5-5', 'toolu_b'),
    );
    const ref = { session_id: SESSION, transcript_path: transcript };
    expect(claudeCode.modelForEdit({ ...ref, tool_use_id: 'toolu_a' })).toBe('claude-opus-5-5');
    expect(claudeCode.modelForEdit({ ...ref, tool_use_id: 'toolu_b' })).toBe('claude-haiku-5-5');
    expect(claudeCode.modelForEdit({ ...ref, tool_use_id: 'toolu_missing' })).toBeUndefined();
    expect(claudeCode.modelForEdit(ref)).toBeUndefined();
  });

  it('sees entries appended after the first lookup', () => {
    writeFileSync(transcript, assistant('claude-opus-5-5', 'toolu_a'));
    const ref = { session_id: SESSION, transcript_path: transcript, tool_use_id: 'toolu_later' };
    expect(claudeCode.modelForEdit(ref)).toBeUndefined();
    appendFileSync(transcript, assistant('claude-sonnet-5-5', 'toolu_later'));
    expect(claudeCode.modelForEdit(ref)).toBe('claude-sonnet-5-5');
  });

  it("reads a subagent's edit from the subagent's own transcript", () => {
    writeFileSync(transcript, assistant('claude-opus-5-5', 'toolu_main'));
    const own = subagentTranscriptPath(transcript, SESSION, 'abc123');
    mkdirSync(path.dirname(own), { recursive: true });
    writeFileSync(own, assistant('claude-haiku-5-5', 'toolu_sub'));
    const ref = { session_id: SESSION, transcript_path: transcript, agent_id: 'abc123', tool_use_id: 'toolu_sub' };
    expect(claudeCode.modelForEdit(ref)).toBe('claude-haiku-5-5');
  });

  it('returns undefined when the transcript is gone', () => {
    const ref = { session_id: SESSION, transcript_path: path.join(repo.tmp, 'deleted.jsonl'), tool_use_id: 'toolu_a' };
    expect(claudeCode.modelForEdit(ref)).toBeUndefined();
  });
});
