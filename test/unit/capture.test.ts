import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readModelFromTail } from '../../src/adapters/claudeCode';
import { ulid } from '../../src/capture/capture';
import { findRepo, readHead, repoRelative } from '../../src/capture/gitDir';
import { strictHash } from '../../src/store/hash';
import type { Edit, Turn } from '../../src/store/schema';

// End-to-end tests of the built hook (dist/tt-capture.js), fed real payloads
// captured from Claude Code 2.1.325. `npm test` builds first.
const root = path.resolve(__dirname, '../..');
const bundle = path.join(root, 'dist/tt-capture.js');
const fixtures = path.join(root, 'test/fixtures/hook-payloads');
const HEAD_SHA = '0123456789abcdef0123456789abcdef01234567';

let tmp: string;
let repo: string;
let home: string;
let transcript: string;

/** A fixture payload with its paths pointed at the temp repo and transcript. */
function payload(name: string): string {
  return readFileSync(path.join(fixtures, `${name}.json`), 'utf8')
    .split('/home/user/.claude/projects/-home-user-demo-repo-src/5ee691c3-5633-469f-a05c-3998c3b459d2.jsonl')
    .join(transcript)
    .split('/home/user/demo-repo')
    .join(repo);
}

function run(mode: string, stdin: string) {
  return spawnSync(process.execPath, [bundle, mode], {
    input: stdin,
    encoding: 'utf8',
    timeout: 5000,
    // The transcript is under tmp, so a subagent's transcript resolves there too.
    env: { ...process.env, THREAD_TRACE_HOME: home, CLAUDE_CODE_EXECPATH: '/opt/claude/versions/2.1.325' },
  });
}

function records<T>(file: string): T[] {
  const full = path.join(repo, '.git/thread-trace', file);
  if (!existsSync(full)) return [];
  return readFileSync(full, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T);
}

function log(): string {
  const file = path.join(home, 'capture.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'tt-capture-'));
  repo = path.join(tmp, 'repo');
  home = path.join(tmp, 'home');
  transcript = path.join(tmp, 'transcripts', 'session.jsonl');
  // A minimal repo, built by hand: the hook reads these files and never runs git.
  mkdirSync(path.join(repo, '.git/refs/heads'), { recursive: true });
  mkdirSync(path.join(repo, 'src'), { recursive: true });
  writeFileSync(path.join(repo, '.git/HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(path.join(repo, '.git/refs/heads/main'), HEAD_SHA + '\n');
  mkdirSync(path.dirname(transcript), { recursive: true });
  // What the transcript holds when the hook runs: the request is logged, but
  // the assistant entry for the current tool call isn't on disk yet.
  writeFileSync(
    transcript,
    [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'api-request', params: { model: 'claude-haiku-5-5' } }),
      JSON.stringify({ type: 'last-prompt', lastPrompt: 'hi' }),
    ].join('\n') + '\n',
  );
});

afterEach(() => {
  try {
    chmodSync(path.join(repo, '.git'), 0o755);
  } catch {
    // Already writable or gone.
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe('tt-capture records a session', () => {
  it('writes one turn and matching edits, with the model filled in', () => {
    const steps: [string, string][] = [
      ['prompt', 'UserPromptSubmit'],
      ['edit', 'PostToolUse-Write-create'],
      ['edit', 'PostToolUse-Edit'],
      ['edit', 'PostToolUse-Edit-replaceAll'],
      ['edit', 'PostToolUse-Write-update'],
    ];
    for (const [mode, name] of steps) {
      const result = run(mode, payload(name));
      expect(result.status, name).toBe(0);
      expect(result.stdout, name).toBe('');
    }
    expect(log()).toBe('');

    const turns = records<Turn>('turns.jsonl');
    expect(turns).toHaveLength(1);
    const [turn] = turns;
    expect(turn).toMatchObject({
      v: 1,
      id: '5ee691c3-5633-469f-a05c-3998c3b459d2:e1141a12-b502-49a7-b092-af626e6e858a',
      agent: { name: 'claude-code', version: '2.1.325' },
      origin: 'human',
      cwd: path.join(repo, 'src'),
      git: { head: HEAD_SHA, branch: 'main' },
      source: 'hook',
    });
    expect(turn.prompt).toMatch(/^This is a tool-behaviour probe/);

    const edits = records<Edit>('edits.jsonl');
    expect(edits.map((e) => [e.tool, e.file])).toEqual([
      ['Write', 'src/a.txt'],
      ['Edit', 'src/a.txt'],
      ['Edit', 'src/existing.txt'],
      ['Write', 'src/a.txt'],
    ]);
    for (const edit of edits) {
      expect(edit.turn_id).toBe(turn.id);
      expect(edit.model).toBe('claude-haiku-5-5');
      expect(edit.base_head).toBe(HEAD_SHA);
      expect(edit.tool_use_id).toMatch(/^toolu_/);
      expect(edit.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    }
    expect(edits[0].hunks[0]).toMatchObject({ start: 1, end: 3 });
    expect(edits[1].hunks[0]).toMatchObject({ start: 2, end: 3, hashes: [strictHash('BETA'), strictHash('BETA2')] });
    expect(edits[1].removed_hashes).toEqual([strictHash('beta')]);
    expect(edits[2].hunks.map((h) => h.start)).toEqual([2, 4]);
  });

  it('links a subagent edit to the parent turn and reads the subagent transcript for the model', () => {
    const subagent = path.join(
      path.dirname(transcript),
      '5ee691c3-5633-469f-a05c-3998c3b459d2/subagents/agent-a7e1a9bf5533c42c8.jsonl',
    );
    mkdirSync(path.dirname(subagent), { recursive: true });
    writeFileSync(subagent, JSON.stringify({ type: 'api-request', params: { model: 'claude-sonnet-5-5' } }) + '\n');

    expect(run('edit', payload('PostToolUse-Edit-subagent')).status).toBe(0);
    const [edit] = records<Edit>('edits.jsonl');
    expect(edit).toMatchObject({
      agent_id: 'a7e1a9bf5533c42c8',
      model: 'claude-sonnet-5-5',
      turn_id: '5ee691c3-5633-469f-a05c-3998c3b459d2:e1141a12-b502-49a7-b092-af626e6e858a',
    });
  });

  it('records a synthetic prompt as an agent turn without its text', () => {
    expect(run('prompt', payload('UserPromptSubmit-taskNotification')).status).toBe(0);
    const [turn] = records<Turn>('turns.jsonl');
    expect(turn).toMatchObject({ origin: 'agent', prompt: '' });
  });

  it('redacts secrets in the stored prompt', () => {
    const p = JSON.parse(payload('UserPromptSubmit'));
    p.prompt = 'deploy with password=hunter2secret';
    expect(run('prompt', JSON.stringify(p)).status).toBe(0);
    expect(records<Turn>('turns.jsonl')[0].prompt).toBe('deploy with password=[REDACTED]');
  });

  it('honours the prompt mode in config.json', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ prompt: 'none' }));
    expect(run('prompt', payload('UserPromptSubmit')).status).toBe(0);
    expect(records<Turn>('turns.jsonl')[0].prompt).toBe('');
  });

  it('ignores edits to files outside any repo, and inside .git', () => {
    const outside = JSON.parse(payload('PostToolUse-Write-create'));
    outside.tool_input.file_path = path.join(tmp, 'elsewhere/scratch.txt');
    outside.tool_response.filePath = outside.tool_input.file_path;
    expect(run('edit', JSON.stringify(outside)).status).toBe(0);

    const inside = JSON.parse(payload('PostToolUse-Write-create'));
    inside.tool_input.file_path = path.join(repo, '.git/hooks/pre-commit');
    inside.tool_response.filePath = inside.tool_input.file_path;
    expect(run('edit', JSON.stringify(inside)).status).toBe(0);

    expect(records<Edit>('edits.jsonl')).toEqual([]);
    expect(log()).toBe('');
  });
});

// Acceptance test 9: failure isolation.
describe('tt-capture failure isolation', () => {
  it.each([
    ['malformed JSON', 'edit', '{not json'],
    ['empty stdin', 'prompt', ''],
    ['a payload of the wrong shape', 'edit', '{"session_id": 5}'],
    ['an unknown mode', 'bogus', '{}'],
  ])('exits 0, prints nothing and logs the error on %s', (_name, mode, stdin) => {
    const result = run(mode, stdin);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(log()).toMatch(new RegExp(`\\[${mode}\\] `));
    expect(existsSync(path.join(repo, '.git/thread-trace'))).toBe(false);
  });

  it('exits 0 and logs the error when .git is read-only', () => {
    chmodSync(path.join(repo, '.git'), 0o555);
    const result = run('edit', payload('PostToolUse-Edit'));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(log()).toMatch(/EACCES|EPERM|EROFS/);
  });

  it('exits 0 even when the log itself cannot be written', () => {
    mkdirSync(home, { recursive: true });
    mkdirSync(path.join(home, 'capture.log')); // a directory where the log file should be
    const result = run('edit', '{not json');
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});

describe('readModelFromTail', () => {
  it('prefers whichever of the last assistant entry and last request is newer', () => {
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'api-request', params: { model: 'claude-opus-5-5' } }),
        JSON.stringify({ type: 'assistant', message: { model: 'claude-fable-5-2', content: [] } }),
        JSON.stringify({ type: 'user', message: { content: 'x' } }),
      ].join('\n') + '\n',
    );
    expect(readModelFromTail(transcript)).toBe('claude-fable-5-2');
  });

  it('skips synthetic assistant entries', () => {
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } }),
        JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', content: [] } }),
      ].join('\n') + '\n',
    );
    expect(readModelFromTail(transcript)).toBe('claude-opus-5-5');
  });

  it('is not fooled by entry-like text inside a prompt', () => {
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'api-request', params: { model: 'claude-opus-5-5' } }),
        JSON.stringify({ type: 'user', message: { content: '{"type":"assistant","message":{"model":"fake"}}' } }),
      ].join('\n') + '\n',
    );
    expect(readModelFromTail(transcript)).toBe('claude-opus-5-5');
  });

  it('reads only the tail of a large file and tolerates a cut-off first line', () => {
    const filler = JSON.stringify({ type: 'api-request-blob', message: 'x'.repeat(5000) });
    writeFileSync(
      transcript,
      [
        JSON.stringify({ type: 'api-request', params: { model: 'old-model' } }),
        ...Array.from({ length: 50 }, () => filler),
        JSON.stringify({ type: 'api-request', params: { model: 'claude-opus-5-5' } }),
      ].join('\n') + '\n',
    );
    expect(readModelFromTail(transcript, 8 * 1024)).toBe('claude-opus-5-5');
  });

  it('returns undefined for a missing transcript or one with no model', () => {
    expect(readModelFromTail(path.join(tmp, 'missing.jsonl'))).toBeUndefined();
    writeFileSync(transcript, JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n');
    expect(readModelFromTail(transcript)).toBeUndefined();
  });
});

describe('gitDir', () => {
  it('finds the repo from a subdirectory and reads HEAD without git', () => {
    const info = findRepo(path.join(repo, 'src'));
    expect(info?.root).toBe(repo);
    expect(readHead(info!)).toEqual({ head: HEAD_SHA, branch: 'main' });
  });

  it('resolves a branch from packed-refs', () => {
    rmSync(path.join(repo, '.git/refs/heads/main'));
    writeFileSync(path.join(repo, '.git/packed-refs'), `# pack-refs with: peeled\n${HEAD_SHA} refs/heads/main\n`);
    expect(readHead(findRepo(repo)!)).toEqual({ head: HEAD_SHA, branch: 'main' });
  });

  it('handles a detached HEAD and a branch with no commits', () => {
    writeFileSync(path.join(repo, '.git/HEAD'), HEAD_SHA + '\n');
    expect(readHead(findRepo(repo)!)).toEqual({ head: HEAD_SHA });
    writeFileSync(path.join(repo, '.git/HEAD'), 'ref: refs/heads/new\n');
    expect(readHead(findRepo(repo)!)).toEqual({ head: '', branch: 'new' });
  });

  it('follows a linked worktree to the shared git dir', () => {
    const worktree = path.join(tmp, 'wt');
    const wtGit = path.join(repo, '.git/worktrees/wt');
    mkdirSync(worktree, { recursive: true });
    mkdirSync(wtGit, { recursive: true });
    writeFileSync(path.join(worktree, '.git'), `gitdir: ${wtGit}\n`);
    writeFileSync(path.join(wtGit, 'commondir'), '../..\n');
    writeFileSync(path.join(wtGit, 'HEAD'), 'ref: refs/heads/main\n');
    const info = findRepo(worktree)!;
    expect(info.commonDir).toBe(path.join(repo, '.git'));
    expect(readHead(info)).toEqual({ head: HEAD_SHA, branch: 'main' });
  });

  it('returns undefined outside a repo', () => {
    expect(findRepo(path.join(tmp, 'transcripts'))).toBeUndefined();
  });

  it('gives repo-relative POSIX paths and rejects outside or .git paths', () => {
    const info = findRepo(repo)!;
    expect(repoRelative(info, path.join(repo, 'src/a.txt'))).toBe('src/a.txt');
    expect(repoRelative(info, path.join(tmp, 'other.txt'))).toBeUndefined();
    expect(repoRelative(info, path.join(repo, '.git/config'))).toBeUndefined();
  });
});

describe('ulid', () => {
  it('is 26 Crockford characters and sorts by time', () => {
    const a = ulid(1_000_000_000_000);
    const b = ulid(1_000_000_000_001);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a.slice(0, 10) < b.slice(0, 10)).toBe(true);
  });
});
