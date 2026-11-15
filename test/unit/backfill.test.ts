import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/adapters/claudeCode';
import { backfill } from '../../src/backfill/backfill';
import { findRepo } from '../../src/capture/gitDir';
import type { Edit, Turn } from '../../src/store/schema';
import { MINUTE, T0, TestRepo } from './helpers/repo';

// Backfill from transcripts (docs/SPEC.md, "Transcript backfill" and
// "M4 decisions"). Entry shapes are the ones seen in transcripts from
// CLI 2.1.325; the transcripts are written under a temp CLAUDE_CONFIG_DIR.

let repo: TestRepo;
let env: NodeJS.ProcessEnv;
let projects: string;
let uuid = 0;
let clock = T0;

beforeEach(() => {
  repo = new TestRepo();
  env = { CLAUDE_CONFIG_DIR: path.join(repo.tmp, 'claude'), THREAD_TRACE_HOME: path.join(repo.tmp, 'home') };
  projects = path.join(repo.tmp, 'claude', 'projects');
  clock = T0;
});
afterEach(() => repo.dispose());

const encode = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, '-');

/** One line of a file, and whether an agent wrote it as it is now. */
interface Line {
  text: string;
  agent?: string;
}

/**
 * Plays an agent session: applies writes and edits to the repo and builds the
 * transcript Claude Code would have left behind.
 */
class Session {
  readonly entries: unknown[] = [];
  private promptId = '';
  private calls = 0;

  constructor(
    readonly id: string,
    private readonly files: Map<string, Line[]>,
    private readonly model = 'claude-opus-5-5',
  ) {}

  private common(extra: object = {}) {
    clock += 1000;
    return {
      uuid: `uuid-${++uuid}`,
      sessionId: this.id,
      version: '2.1.325',
      gitBranch: 'main',
      cwd: repo.root,
      timestamp: new Date(clock).toISOString(),
      ...(this.promptId ? { promptId: this.promptId } : {}),
      ...extra,
    };
  }

  prompt(text: string, extra: object = { promptSource: 'typed', origin: { kind: 'human' } }): this {
    this.promptId = `prompt-${++uuid}`;
    this.entries.push({ ...this.common(), type: 'user', message: { role: 'user', content: text }, ...extra });
    return this;
  }

  /** An entry without a prompt id: a slash command, or a meta entry. */
  raw(entry: object): this {
    this.entries.push({ ...this.common(), ...entry });
    return this;
  }

  call(name: string, input: object, result: unknown, isError = false): string {
    const id = `toolu_${this.id}_${++this.calls}`;
    this.entries.push({ ...this.common(), type: 'assistant', message: { model: this.model, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } });
    if (result !== undefined) {
      this.entries.push({
        ...this.common(),
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] },
        toolUseResult: result,
      });
    }
    return id;
  }

  /** The agent creates a file. */
  write(file: string, lines: string[]): string {
    const content = lines.join('\n') + '\n';
    this.files.set(file, lines.map((text) => ({ text, agent: this.id })));
    repo.write(file, content);
    const filePath = path.join(repo.root, file);
    return this.call('Write', { file_path: filePath, content }, { type: 'create', filePath, content, structuredPatch: [], originalFile: null });
  }

  /** The agent replaces `remove` lines at 1-based line `at` with `lines`. `patch: false` leaves the patch out of the result. */
  edit(file: string, at: number, remove: number, lines: string[], patch = true): string {
    const current = this.files.get(file) ?? [];
    const removed = current.splice(at - 1, remove, ...lines.map((text) => ({ text, agent: this.id })));
    this.files.set(file, current);
    repo.write(file, current.map((line) => line.text).join('\n') + '\n');
    const filePath = path.join(repo.root, file);
    const oldString = removed.map((line) => line.text).join('\n');
    const newString = lines.join('\n');
    const structuredPatch = [
      { oldStart: at, oldLines: remove, newStart: at, newLines: lines.length, lines: [...removed.map((line) => `-${line.text}`), ...lines.map((text) => `+${text}`)] },
    ];
    return this.call(
      'Edit',
      { file_path: filePath, old_string: oldString, new_string: newString },
      patch ? { filePath, oldString, newString, structuredPatch, userModified: false, replaceAll: false } : 'The file has been updated.',
    );
  }

  /** Writes the transcript where Claude Code keeps it. `agentId` makes it a subagent's file under `parent`. */
  save(folder = encode(repo.root), parent?: string, agentId?: string): string {
    const dir = parent ? path.join(projects, folder, parent, 'subagents') : path.join(projects, folder);
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, parent ? `agent-${agentId}.jsonl` : `${this.id}.jsonl`);
    writeFileSync(file, this.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    return file;
  }
}

/** A person changes lines by hand: no transcript, and the lines stop being the agent's. */
function human(files: Map<string, Line[]>, file: string, at: number, remove: number, lines: string[]): void {
  const current = files.get(file) ?? [];
  current.splice(at - 1, remove, ...lines.map((text) => ({ text })));
  files.set(file, current);
  repo.write(file, current.map((line) => line.text).join('\n') + '\n');
}

function records<T>(file: 'turns.jsonl' | 'edits.jsonl'): T[] {
  const full = path.join(repo.records, file);
  if (!existsSync(full)) return [];
  return readFileSync(full, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as T);
}

const run = (options: Partial<Parameters<typeof backfill>[1]> = {}) => backfill(findRepo(repo.root)!, { env, ...options });

const CART = [
  'export interface Item {',
  '  price: number;',
  '  quantity: number;',
  '}',
  '',
  'export function subtotal(items: Item[]): number {',
  '  let sum = 0;',
  '  for (const item of items) {',
  '    sum += item.price * item.quantity;',
  '  }',
  '  return sum;',
  '}',
];
const UTIL = ['export function round(value: number): number {', '  return Math.round(value * 100) / 100;', '}'];

describe('8: backfill', () => {
  it('attributes at least 90% of the agent lines that are still unchanged, on a repo with no hook records', async () => {
    const files = new Map<string, Line[]>();
    human(files, 'README.md', 1, 0, ['# Shop', '', 'A small shop.']);
    repo.commit('Start', T0 - 60 * MINUTE);

    const first = new Session('11111111-aaaa-4bbb-8ccc-000000000001', files);
    first.prompt('Build the cart module\nwith a subtotal function');
    first.write('src/cart.ts', CART);
    first.edit('src/cart.ts', 7, 1, ['  // Sum of price times quantity.', '  let sum = 0;']);
    first.write('src/util.ts', UTIL);
    first.save();

    const second = new Session('22222222-aaaa-4bbb-8ccc-000000000002', files, 'claude-sonnet-5-5');
    second.prompt('Add tax support');
    second.edit('src/cart.ts', 14, 0, ['', 'export function withTax(amount: number, rate: number): number {', '  return round(amount * (1 + rate));', '}']);
    second.edit('src/cart.ts', 1, 0, ["import { round } from './util';", '']);
    second.edit('README.md', 4, 0, ['', 'Prices include tax when `withTax` is used.']);
    second.save();
    repo.commit('Add cart with tax', clock + 5 * MINUTE);

    // Later, by hand: one agent line is rewritten and a few lines are added.
    human(files, 'src/cart.ts', 10, 1, ['  let sum = 0.0;']);
    human(files, 'src/util.ts', 4, 0, ['', 'export const CURRENCY = "EUR";']);
    repo.commit('Tidy up', clock + 60 * MINUTE);

    expect(records('edits.jsonl')).toHaveLength(0);
    const result = await run();
    expect(result).toMatchObject({ transcripts: 2, sessions: 2, edits: 6, turns: 2, existing: 0, skipped: 0, cancelled: false });

    const resolver = repo.resolver();
    const prompts: Record<string, string> = { [first.id]: 'Build the cart module', [second.id]: 'Add tax support' };
    const models: Record<string, string> = { [first.id]: 'claude-opus-5-5', [second.id]: 'claude-sonnet-5-5' };
    let agentLines = 0;
    let attributed = 0;
    const missed: string[] = [];
    for (const [file, lines] of files) {
      for (let n = 1; n <= lines.length; n++) {
        const { text, agent } = lines[n - 1];
        const found = await repo.resolve(file, n, resolver);
        const byAgent = found.confidence === 'exact' || found.confidence === 'likely';
        if (!agent) {
          // A line nobody's agent wrote must not be claimed, apart from weak lines inside an agent block.
          if (/\w/.test(text)) expect(byAgent, `${file}:${n} ${text}`).toBe(false);
          continue;
        }
        agentLines++;
        if (byAgent && found.turn?.prompt.startsWith(prompts[agent]) && found.edit?.model === models[agent] && found.edit.source === 'backfill') {
          attributed++;
        } else {
          missed.push(`${file}:${n} ${JSON.stringify(text)} → ${found.confidence}`);
        }
      }
    }
    expect(agentLines).toBeGreaterThan(20);
    expect(attributed / agentLines, `missed:\n${missed.join('\n')}`).toBeGreaterThanOrEqual(0.9);

    // A patch in the transcript gives positions, so an unmoved line is exact.
    const line = files.get('src/util.ts')!.findIndex((entry) => entry.text.includes('Math.round')) + 1;
    expect((await repo.resolve('src/util.ts', line, resolver)).confidence).toBe('exact');
    // The rewritten line is the person's now, with the agent's thread behind it.
    const rewritten = files.get('src/cart.ts')!.findIndex((entry) => entry.text.includes('0.0')) + 1;
    expect((await repo.resolve('src/cart.ts', rewritten, resolver)).confidence).toBe('modified');
  });
});

describe('backfill records', () => {
  it('writes the same records as the hook, tagged backfill', async () => {
    const session = new Session('33333333-aaaa-4bbb-8ccc-000000000003', new Map());
    session.prompt('Add a rounding helper');
    const call = session.write('src/util.ts', UTIL);
    const transcript = session.save();
    await run();

    const [turn] = records<Turn>('turns.jsonl');
    const [edit] = records<Edit>('edits.jsonl');
    expect(turn).toMatchObject({
      v: 1,
      agent: { name: 'claude-code', version: '2.1.325' },
      session_id: session.id,
      transcript_path: transcript,
      prompt: 'Add a rounding helper',
      origin: 'human',
      cwd: repo.root,
      git: { head: '', branch: 'main' },
      source: 'backfill',
    });
    expect(turn.id).toMatch(new RegExp(`^${session.id}:prompt-\\d+$`));
    expect(turn.prompt_entry_id).toMatch(/^uuid-/);
    expect(edit).toMatchObject({
      v: 1,
      turn_id: turn.id,
      session_id: session.id,
      tool_use_id: call,
      tool: 'Write',
      model: 'claude-opus-5-5',
      file: 'src/util.ts',
      base_head: '',
      source: 'backfill',
    });
    expect(edit.hunks).toHaveLength(1);
    expect(edit.hunks[0]).toMatchObject({ start: 1, end: 3 });
    expect(edit.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Date.parse(edit.ts)).toBeGreaterThan(Date.parse(turn.ts));
  });

  it('adds nothing on a second run, and picks up what was appended since', async () => {
    const files = new Map<string, Line[]>();
    const session = new Session('44444444-aaaa-4bbb-8ccc-000000000004', files);
    session.prompt('Add a rounding helper');
    session.write('src/util.ts', UTIL);
    session.save();
    expect(await run()).toMatchObject({ edits: 1, turns: 1, existing: 0 });
    expect(await run()).toMatchObject({ edits: 0, turns: 0, existing: 1, sessions: 0 });

    session.edit('src/util.ts', 1, 0, ['// Rounds to cents.']);
    session.save();
    // Same turn: the turn record is not written twice.
    expect(await run()).toMatchObject({ edits: 1, turns: 0, existing: 1 });
    expect(records('edits.jsonl')).toHaveLength(2);
    expect(records('turns.jsonl')).toHaveLength(1);
  });

  it('does not duplicate an edit the hook already recorded', async () => {
    const session = new Session('55555555-aaaa-4bbb-8ccc-000000000005', new Map());
    session.prompt('Add a rounding helper');
    const call = session.write('src/util.ts', UTIL);
    session.save();
    repo.addEdit({ file: 'src/util.ts', start: 1, lines: UTIL, ts: clock, tool_use_id: call, session_id: session.id });

    expect(await run()).toMatchObject({ edits: 0, turns: 0, existing: 1 });
    expect(records<Edit>('edits.jsonl').map((edit) => edit.source)).toEqual(['hook']);
  });

  it('skips rejected edits, calls with no result, and files outside the repo', async () => {
    const files = new Map<string, Line[]>();
    const session = new Session('66666666-aaaa-4bbb-8ccc-000000000006', files);
    session.prompt('Add a rounding helper');
    session.write('src/util.ts', UTIL);
    const inside = path.join(repo.root, 'src/util.ts');
    session.call('Edit', { file_path: inside, old_string: 'round', new_string: 'rejectedName' }, 'The user rejected this edit', true);
    session.call('Edit', { file_path: inside, old_string: 'round', new_string: 'pendingName' }, undefined);
    session.call('Write', { file_path: path.join(repo.tmp, 'scratch.md'), content: 'notes\n' }, { type: 'create', structuredPatch: [] });
    session.call('Write', { file_path: path.join(repo.root, '.git', 'config'), content: 'x\n' }, { type: 'create', structuredPatch: [] });
    session.call('Read', { file_path: inside }, { type: 'text' });
    session.save();

    expect(await run()).toMatchObject({ edits: 1, skipped: 4 });
    expect(records<Edit>('edits.jsonl').map((edit) => edit.file)).toEqual(['src/util.ts']);
  });

  it('ignores slash commands and meta entries, and records an agent-submitted prompt without its text', async () => {
    const files = new Map<string, Line[]>();
    const session = new Session('77777777-aaaa-4bbb-8ccc-000000000007', files);
    session.raw({ type: 'user', isMeta: true, message: { role: 'user', content: '<local-command-caveat>ignore</local-command-caveat>' } });
    session.raw({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } });
    session.prompt('Add a rounding helper');
    session.write('src/util.ts', UTIL);
    session.prompt('<task-notification>agent 3 finished</task-notification>', { promptSource: 'system', origin: { kind: 'task-notification' } });
    session.edit('src/util.ts', 1, 0, ['// Rounds to cents.']);
    session.save();
    await run();

    const turns = records<Turn>('turns.jsonl');
    expect(turns.map((turn) => [turn.origin, turn.prompt])).toEqual([
      ['human', 'Add a rounding helper'],
      ['agent', ''],
    ]);
    expect(records<Edit>('edits.jsonl').map((edit) => edit.turn_id)).toEqual(turns.map((turn) => turn.id));
  });

  it('records hashes without positions when the result has no patch, which resolves as likely', async () => {
    const files = new Map<string, Line[]>();
    human(files, 'src/util.ts', 1, 0, UTIL);
    repo.commit('Start', T0 - 60 * MINUTE);
    const session = new Session('88888888-aaaa-4bbb-8ccc-000000000008', files);
    session.prompt('Document it');
    session.edit('src/util.ts', 1, 0, ['// Rounds an amount to whole cents.'], false);
    session.save();
    repo.commit('Document round', clock + MINUTE);
    await run();

    const [edit] = records<Edit>('edits.jsonl');
    expect(edit.hunks).toHaveLength(1);
    expect(edit.hunks[0].start).toBeUndefined();
    expect(edit.hunks[0].hashes).toHaveLength(1);
    const found = await repo.resolve('src/util.ts', 1);
    expect(found.confidence).toBe('likely');
    expect(found.turn?.prompt).toBe('Document it');
  });

  it("links a subagent's edit to the session's prompt and marks it with the agent id", async () => {
    const files = new Map<string, Line[]>();
    const parent = new Session('99999999-aaaa-4bbb-8ccc-000000000009', files);
    parent.prompt('Build the cart module');
    parent.call('Agent', { description: 'write util', prompt: 'Write src/util.ts' }, { status: 'ok' });
    parent.save();
    const sub = new Session(parent.id, files, 'claude-haiku-5-5');
    // The subagent's transcript opens with its task; it holds no prompt of the user's.
    sub.raw({ type: 'user', isSidechain: true, message: { role: 'user', content: 'Write src/util.ts' } });
    sub.write('src/util.ts', UTIL);
    sub.save(undefined, parent.id, 'a1b2c3');
    repo.commit('Add util', clock + MINUTE);

    expect(await run()).toMatchObject({ transcripts: 2, sessions: 1, edits: 1, turns: 1 });
    const [edit] = records<Edit>('edits.jsonl');
    expect(edit).toMatchObject({ session_id: parent.id, agent_id: 'a1b2c3', model: 'claude-haiku-5-5' });
    const found = await repo.resolve('src/util.ts', 2);
    expect(found.confidence).toBe('exact');
    expect(found.turn?.prompt).toBe('Build the cart module');
    expect(found.turn?.transcript_path).toBe(path.join(projects, encode(repo.root), `${parent.id}.jsonl`));
  });

  it('redacts prompts and honours the prompt mode, like the hook', async () => {
    const session = new Session('aaaaaaaa-aaaa-4bbb-8ccc-00000000000a', new Map());
    session.prompt('Use the key sk-abcdefghijklmnopqrstuvwxyz012345 for the API\nand keep it out of the repo');
    session.write('src/util.ts', UTIL);
    session.save();
    await run();
    expect(records<Turn>('turns.jsonl')[0].prompt).toBe('Use the key [REDACTED] for the API\nand keep it out of the repo');

    const other = new Session('bbbbbbbb-aaaa-4bbb-8ccc-00000000000b', new Map());
    other.prompt('Second prompt\nwith two lines');
    other.write('src/other.ts', UTIL);
    other.save();
    mkdirSync(env.THREAD_TRACE_HOME!, { recursive: true });
    writeFileSync(path.join(env.THREAD_TRACE_HOME!, 'config.json'), JSON.stringify({ prompt: 'firstLine' }));
    await run();
    expect(records<Turn>('turns.jsonl')[1].prompt).toBe('Second prompt');
  });

  it('finds sessions started in a subfolder, and drops a sibling folder whose name only looks alike', async () => {
    const files = new Map<string, Line[]>();
    const nested = new Session('cccccccc-aaaa-4bbb-8ccc-00000000000c', files);
    nested.prompt('Add a rounding helper');
    nested.write('src/util.ts', UTIL);
    nested.save(encode(path.join(repo.root, 'src')));

    // `<repo>-old` encodes to a name that starts like the repo's own.
    const sibling = new Session('dddddddd-aaaa-4bbb-8ccc-00000000000d', new Map());
    sibling.prompt('Unrelated work');
    sibling.call('Write', { file_path: `${repo.root}-old/src/x.ts`, content: 'x\n' }, { type: 'create', structuredPatch: [] });
    sibling.save(encode(`${repo.root}-old`));

    // A different project altogether is not read.
    const unrelated = new Session('eeeeeeee-aaaa-4bbb-8ccc-00000000000e', new Map());
    unrelated.prompt('Elsewhere');
    unrelated.save(encode('/somewhere/else'));

    expect(claudeCode.findTranscripts(repo.root, env).map((file) => file.session_id).sort()).toEqual([nested.id, sibling.id]);
    expect(await run()).toMatchObject({ transcripts: 2, edits: 1, skipped: 1 });
  });

  it('stops when cancelled and reports progress', async () => {
    for (const id of ['f1', 'f2', 'f3']) {
      const session = new Session(id, new Map());
      session.prompt(`Prompt ${id}`);
      session.write(`src/${id}.ts`, UTIL);
      session.save();
    }
    const abort = new AbortController();
    const progress: string[] = [];
    const result = await run({
      signal: abort.signal,
      onProgress: (done, total) => {
        progress.push(`${done}/${total}`);
        abort.abort();
      },
    });
    expect(result).toMatchObject({ cancelled: true, transcripts: 1, edits: 1 });
    expect(progress).toEqual(['1/3']);
    // The rest is imported by the next run.
    expect(await run()).toMatchObject({ cancelled: false, edits: 2, existing: 1 });
  });

  it('does nothing when there are no transcripts', async () => {
    expect(await run()).toMatchObject({ transcripts: 0, edits: 0, turns: 0 });
    expect(existsSync(repo.records)).toBe(false);
  });
});
