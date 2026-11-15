// A real git repo in a temp dir, with helpers to write Thread Trace records
// into it directly. Used by the read-side tests.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Git } from '../../../src/git/exec';
import { Resolver } from '../../../src/resolve/resolver';
import { looseHash, strictHash } from '../../../src/store/hash';
import type { Edit, Turn } from '../../../src/store/schema';
import { TraceStore } from '../../../src/store/traceStore';

// Keep the machine's git config (signing, hooks, default branch) out of the
// tests. Set on process.env because the code under test spawns git too.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_SYSTEM: os.devNull,
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Julian',
  GIT_AUTHOR_EMAIL: 'julian@example.com',
  GIT_COMMITTER_NAME: 'Julian',
  GIT_COMMITTER_EMAIL: 'julian@example.com',
});

export const T0 = Date.parse('2026-11-10T12:00:00Z');
export const MINUTE = 60_000;
export const DAY = 24 * 60 * MINUTE;
export const SESSION = '5ee691c3-5633-469f-a05c-3998c3b459d2';

let counter = 0;

export class TestRepo {
  readonly tmp = mkdtempSync(path.join(os.tmpdir(), 'tt-read-'));
  readonly root = path.join(this.tmp, 'repo');
  readonly records = path.join(this.root, '.git', 'thread-trace');

  constructor() {
    mkdirSync(this.root);
    this.git('init', '-q', '-b', 'main');
  }

  git(...args: string[]): string {
    return execFileSync('git', args, { cwd: this.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  }

  write(file: string, text: string): void {
    const full = path.join(this.root, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, text);
  }

  read(file: string): string {
    return readFileSync(path.join(this.root, file), 'utf8');
  }

  /** Commits everything, with author and committer time set to `when`. Returns the sha. */
  commit(message: string, when: number, author = 'Julian'): string {
    const date = new Date(when).toISOString();
    this.git('add', '-A');
    execFileSync('git', ['commit', '-q', '-m', message], {
      cwd: this.root,
      env: { ...process.env, GIT_AUTHOR_NAME: author, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    });
    return this.git('rev-parse', 'HEAD');
  }

  addTurn(turn: Partial<Turn> & { id: string }): Turn {
    const record: Turn = {
      v: 1,
      agent: { name: 'claude-code', version: '2.1.325' },
      session_id: SESSION,
      prompt: 'Add a helper',
      origin: 'human',
      ts: new Date(T0).toISOString(),
      cwd: this.root,
      git: { head: '' },
      source: 'hook',
      ...turn,
    };
    this.append('turns.jsonl', record);
    return record;
  }

  /** Records an edit that wrote `lines` to `file` starting at line `start`. */
  addEdit(edit: { file: string; start?: number; lines: string[]; ts: number } & Partial<Omit<Edit, 'ts' | 'file'>>): Edit {
    const { start, lines, ts, ...rest } = edit;
    const record: Edit = {
      v: 1,
      id: `EDIT${String(++counter).padStart(6, '0')}`,
      turn_id: `${SESSION}:p1`,
      session_id: SESSION,
      tool: 'Edit',
      model: 'claude-opus-5-5',
      hunks: [
        {
          start,
          end: start === undefined ? undefined : start + lines.length - 1,
          hashes: lines.map(strictHash),
          loose: lines.map(looseHash),
        },
      ],
      base_head: '',
      source: 'hook',
      ...rest,
      ts: new Date(ts).toISOString(),
    };
    this.append('edits.jsonl', record);
    return record;
  }

  append(file: string, record: unknown): void {
    mkdirSync(this.records, { recursive: true });
    appendFileSync(path.join(this.records, file), JSON.stringify(record) + '\n');
  }

  resolver(): Resolver {
    return new Resolver(new Git(this.root), new TraceStore(this.records));
  }

  /** Resolves a 1-based line of a file as it is on disk. */
  resolve(file: string, line: number, resolver = this.resolver()) {
    return resolver.resolve({ file, line, text: this.read(file) });
  }

  dispose(): void {
    rmSync(this.tmp, { recursive: true, force: true });
  }
}
