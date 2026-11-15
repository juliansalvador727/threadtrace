import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Git } from '../../src/git/exec';
import { commitFileChange, formerPaths, lineHistory } from '../../src/git/log';
import { commitTrailers, hasAgentTrailer, parseTrailers } from '../../src/git/trailers';
import { MINUTE, T0, TestRepo } from './helpers/repo';

const SESSION_URL = 'https://claude.ai/code/session_01AbCdEfGh';
const AGENT = 'Claude Opus 5.5 <noreply@anthropic.com>';

describe('parseTrailers', () => {
  it('reads the session link and the agent co-author', () => {
    const trailers = parseTrailers(`Co-Authored-By: ${AGENT}\nClaude-Session: ${SESSION_URL}`);
    expect(trailers).toEqual({ session: SESSION_URL, coAuthor: 'Claude Opus 5.5' });
    expect(hasAgentTrailer(trailers)).toBe(true);
  });

  it("accepts git's separator, any key case and extra spaces", () => {
    expect(parseTrailers(`co-authored-by:   ${AGENT}  \x02CLAUDE-SESSION:${SESSION_URL}\x02`)).toEqual({
      session: SESSION_URL,
      coAuthor: 'Claude Opus 5.5',
    });
  });

  it('ignores human co-authors and unrelated trailers', () => {
    const trailers = parseTrailers('Co-authored-by: Sam <sam@example.com>\nSigned-off-by: Julian <julian@example.com>\nReviewed-by: Claude <claude@example.com>');
    expect(trailers).toEqual({});
    expect(hasAgentTrailer(trailers)).toBe(false);
  });

  it('picks the agent out of several co-authors', () => {
    expect(parseTrailers(`Co-authored-by: Sam <sam@example.com>\nCo-Authored-By: ${AGENT}`).coAuthor).toBe('Claude Opus 5.5');
  });

  it('falls back to a plain name when the agent address has none, and caps a long one', () => {
    expect(parseTrailers('Co-Authored-By: <noreply@anthropic.com>').coAuthor).toBe('Claude');
    expect(parseTrailers(`Co-Authored-By: ${'x'.repeat(300)} <noreply@anthropic.com>`).coAuthor).toHaveLength(80);
  });

  it('keeps a session link only when it is an https link to claude.ai', () => {
    for (const url of [
      'http://claude.ai/code/session_1',
      'https://evil.example/code/session_1',
      'https://claude.ai.evil.example/session_1',
      'https://claude.ai@evil.example/session_1',
      'https://user:pw@claude.ai/session_1',
      'javascript:alert(1)',
      'command:workbench.action.terminal.new',
      'https://claude.ai/code/session 1',
      `https://claude.ai/${'a'.repeat(600)}`,
      'not a url',
    ]) {
      expect(parseTrailers(`Claude-Session: ${url}`), url).toEqual({});
    }
  });

  it('is not fooled by trailer-like text without a key', () => {
    expect(parseTrailers(`${SESSION_URL}\nno colon here`)).toEqual({});
  });
});

describe('trailers from git', () => {
  let repo: TestRepo;
  beforeEach(() => {
    repo = new TestRepo();
  });
  afterEach(() => repo.dispose());

  it('reads the trailers of a commit, and none from a plain one', async () => {
    repo.write('a.txt', 'one\n');
    const plain = repo.commit('Plain commit\n\nThe body mentions Claude-Session: but not as a trailer.\n\nMore text.', T0);
    repo.write('a.txt', 'two\n');
    const agent = repo.commit(`Change the line\n\nBody text.\n\nCo-Authored-By: ${AGENT}\nClaude-Session: ${SESSION_URL}`, T0 + MINUTE);
    const git = new Git(repo.root);
    expect(await commitTrailers(git, agent)).toEqual({ session: SESSION_URL, coAuthor: 'Claude Opus 5.5' });
    expect(await commitTrailers(git, plain)).toEqual({});
    expect(await commitTrailers(git, '0'.repeat(40))).toEqual({});
  });

  it("carries trailers on a line's older commits", async () => {
    repo.write('a.txt', 'one\n');
    repo.commit(`First version\n\nClaude-Session: ${SESSION_URL}`, T0);
    repo.write('a.txt', 'two\n');
    const head = repo.commit('Second version', T0 + MINUTE);
    const chain = await lineHistory(new Git(repo.root), head, 'a.txt', 1);
    expect(chain.map((commit) => [commit.summary, commit.trailers])).toEqual([
      ['Second version', {}],
      ['First version', { session: SESSION_URL }],
    ]);
  });
});

describe('formerPaths', () => {
  let repo: TestRepo;
  beforeEach(() => {
    repo = new TestRepo();
  });
  afterEach(() => repo.dispose());

  it('lists the names a file had, newest first', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n';
    repo.write('src/first.ts', body);
    repo.commit('Add', T0);
    repo.git('mv', 'src/first.ts', 'src/second.ts');
    repo.commit('Rename once', T0 + MINUTE);
    mkdirSync(path.join(repo.root, 'lib'));
    repo.git('mv', 'src/second.ts', 'lib/third näme.ts');
    repo.commit('Rename twice', T0 + 2 * MINUTE);
    const git = new Git(repo.root);
    expect(await formerPaths(git, 'lib/third näme.ts')).toEqual(['src/second.ts', 'src/first.ts']);
    expect(await formerPaths(git, 'src/missing.ts')).toEqual([]);
  });
});

describe('commitFileChange', () => {
  let repo: TestRepo;
  let git: Git;
  const body = Array.from({ length: 12 }, (_, i) => `export const value${i} = ${i};`).join('\n') + '\n';
  beforeEach(() => {
    repo = new TestRepo();
    git = new Git(repo.root);
  });
  afterEach(() => repo.dispose());

  it('has no left side in the root commit', async () => {
    repo.write('a.ts', body);
    const root = repo.commit('Add', T0);
    expect(await commitFileChange(git, root, 'a.ts')).toEqual({ after: 'a.ts' });
  });

  it('has no left side for a file the commit added', async () => {
    repo.write('a.ts', body);
    repo.commit('Add a', T0);
    repo.write('src/b.ts', body);
    const added = repo.commit('Add b', T0 + MINUTE);
    expect(await commitFileChange(git, added, 'src/b.ts')).toEqual({ after: 'src/b.ts' });
  });

  it('uses the same path on both sides for a modified file', async () => {
    repo.write('a.ts', body);
    repo.commit('Add', T0);
    repo.write('a.ts', body + 'export const more = 1;\n');
    const changed = repo.commit('Change', T0 + MINUTE);
    expect(await commitFileChange(git, changed, 'a.ts')).toEqual({ before: 'a.ts', after: 'a.ts' });
  });

  it('follows a rename in the commit', async () => {
    repo.write('old name.ts', body);
    repo.commit('Add', T0);
    repo.git('mv', 'old name.ts', 'new näme.ts');
    repo.write('new näme.ts', body + 'export const more = 1;\n');
    const renamed = repo.commit('Rename and change', T0 + MINUTE);
    expect(await commitFileChange(git, renamed, 'new näme.ts')).toEqual({ before: 'old name.ts', after: 'new näme.ts' });
  });

  it('finds the former name in a commit from before a later rename', async () => {
    repo.write('src/first.ts', body);
    const added = repo.commit('Add', T0);
    repo.write('src/first.ts', body + 'export const more = 1;\n');
    const changed = repo.commit('Change', T0 + MINUTE);
    repo.git('mv', 'src/first.ts', 'src/second.ts');
    repo.commit('Rename', T0 + 2 * MINUTE);
    expect(await commitFileChange(git, changed, 'src/second.ts')).toEqual({ before: 'src/first.ts', after: 'src/first.ts' });
    expect(await commitFileChange(git, added, 'src/second.ts')).toEqual({ after: 'src/first.ts' });
  });

  it('compares a merge with its first parent', async () => {
    repo.write('a.ts', body);
    repo.commit('Add a', T0);
    repo.git('checkout', '-q', '-b', 'side');
    repo.write('b.ts', body);
    repo.commit('Add b on side', T0 + MINUTE);
    repo.git('checkout', '-q', 'main');
    repo.write('a.ts', body + 'export const more = 1;\n');
    repo.commit('Change a', T0 + 2 * MINUTE);
    repo.git('merge', '-q', '--no-edit', 'side');
    const merge = repo.git('rev-parse', 'HEAD');
    expect(await commitFileChange(git, merge, 'b.ts')).toEqual({ after: 'b.ts' });
    expect(await commitFileChange(git, merge, 'a.ts')).toEqual({ before: 'a.ts', after: 'a.ts' });
  });

  it('is undefined for a file that is not in the commit', async () => {
    repo.write('a.ts', body);
    const root = repo.commit('Add', T0);
    expect(await commitFileChange(git, root, 'missing.ts')).toBeUndefined();
  });
});
