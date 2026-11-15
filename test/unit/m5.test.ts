import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AGENT_TRACE_FILE, METADATA_KEY, buildTraceRecords, collectAgentTrace, mergeTraceFile, modelId, traceTotals, writeAgentTrace } from '../../src/adapters/agentTrace';
import { loadConfig } from '../../src/capture/capture';
import { Git } from '../../src/git/exec';
import { mergeCaptureConfig, syncCaptureConfig } from '../../src/install/captureConfig';
import { Resolver } from '../../src/resolve/resolver';
import type { Attribution } from '../../src/store/schema';
import { TraceStore } from '../../src/store/traceStore';
import { ColorSlots, fileThreads, heatmapBarSvg, legendRows, ownerOf, statusText, summarize } from '../../src/ui/fileSummary';
import { DAY, MINUTE, SESSION, T0, TestRepo } from './helpers/repo';

// M5: whole-file resolution (heatmap, status bar), the Agent Threads view's
// rows, the Agent Trace export and the capture settings file.
const bundle = path.resolve(__dirname, '../../dist/tt-capture.js');
const OTHER_SESSION = '0b0e7a51-1111-4222-8333-444455556666';

let repo: TestRepo;
beforeEach(() => {
  repo = new TestRepo();
});
afterEach(() => repo.dispose());

const TOTAL = ['export function total(price: number, quantity: number) {', '  const total = price * quantity;', '  return total;', '}'];
const TAX = ['export function tax(amount: number) {', '  return amount * 0.2;', '}'];
const SHIPPING = ['export function shipping(weight: number) {', '  return weight > 10 ? 15 : 5;', '}'];

/**
 * src/app.ts with every kind of line:
 *  1     `// app`            typed by hand
 *  2-5   total()             written by Opus (session 1), line 3 then changed by Dana
 *  6     blank
 *  7-9   tax()               written by Sonnet (session 2)
 *  10-13 blank, shipping()   from a cloud session: commit trailers only
 *  14    `export const …`    typed by hand
 */
function mixedFile(): void {
  repo.write('src/app.ts', '// app\n');
  repo.commit('base', T0 - DAY);

  repo.write('src/app.ts', ['// app', ...TOTAL, ''].join('\n'));
  repo.addTurn({ id: `${SESSION}:p1`, prompt: 'Add a total() helper\nthat multiplies price by quantity', thread_url: 'https://claude.ai/code/session_one' });
  repo.addEdit({ file: 'src/app.ts', start: 2, lines: TOTAL, ts: T0, tool_use_id: 'toolu_1' });
  repo.commit('Add total helper', T0 + 5 * MINUTE);

  repo.write('src/app.ts', ['// app', ...TOTAL, '', ...TAX, ''].join('\n'));
  repo.addTurn({ id: `${OTHER_SESSION}:p1`, session_id: OTHER_SESSION, prompt: 'Add tax', ts: new Date(T0 + 60 * MINUTE).toISOString() });
  repo.addEdit({
    file: 'src/app.ts',
    start: 7,
    lines: TAX,
    ts: T0 + 60 * MINUTE,
    turn_id: `${OTHER_SESSION}:p1`,
    session_id: OTHER_SESSION,
    model: 'claude-sonnet-5-5',
    tool: 'Write',
  });
  repo.commit('Add tax helper', T0 + 65 * MINUTE);

  repo.write('src/app.ts', ['// app', ...TOTAL, '', ...TAX, '', ...SHIPPING, ''].join('\n'));
  repo.commit('Add shipping\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_cloud', T0 + 2 * DAY);

  const tweaked = [...TOTAL];
  tweaked[1] = '  const sum = price * quantity;';
  repo.write('src/app.ts', ['// app', ...tweaked, '', ...TAX, '', ...SHIPPING, 'export const typedByHand = 1;', ''].join('\n'));
  repo.commit('Rename total to sum', T0 + 3 * DAY, 'Dana');
}

const EXPECTED = ['none', 'exact', 'modified', 'exact', 'exact', 'none', 'exact', 'exact', 'exact', 'commit', 'commit', 'commit', 'commit', 'none'];

describe('whole-file resolution', () => {
  it('gives every line the answer the single-line resolver gives it, with one blame', async () => {
    mixedFile();
    const text = repo.read('src/app.ts');
    const git = new Git(repo.root);
    let blames = 0;
    const run = git.run.bind(git);
    git.run = (args, stdin) => {
      if (args[0] === 'blame') blames++;
      return run(args, stdin);
    };
    const all = await new Resolver(git, new TraceStore(repo.records)).resolveFile({ file: 'src/app.ts', text });
    expect(blames).toBe(1);
    expect(all.map((entry) => entry.confidence)).toEqual(EXPECTED);
    expect(all.map((entry) => entry.line)).toEqual(EXPECTED.map((_, index) => index + 1));

    const resolver = repo.resolver();
    for (let line = 1; line <= EXPECTED.length; line++) {
      const single = await resolver.resolve({ file: 'src/app.ts', line, text });
      expect({ confidence: single.confidence, edit: single.edit?.id, commit: single.commit?.sha, trailers: single.commit?.trailers }).toEqual({
        confidence: all[line - 1].confidence,
        edit: all[line - 1].edit?.id,
        commit: all[line - 1].commit?.sha,
        trailers: all[line - 1].commit?.trailers,
      });
    }
  });

  it('handles an empty file and a file git has never seen', async () => {
    repo.write('empty.ts', '');
    repo.write('new.ts', TOTAL.join('\n') + '\n');
    repo.addEdit({ file: 'new.ts', start: 1, lines: TOTAL, ts: T0 });
    expect(await repo.resolver().resolveFile({ file: 'empty.ts', text: '' })).toEqual([]);
    const all = await repo.resolver().resolveFile({ file: 'new.ts', text: repo.read('new.ts') });
    expect(all.map((entry) => entry.confidence)).toEqual(['exact', 'exact', 'exact', 'exact']);
  });

  it("doesn't read old versions of a file no agent ever wrote to", async () => {
    repo.write('human.ts', 'export const a = 1;\n');
    repo.commit('one', T0);
    repo.write('human.ts', 'export const a = 2;\nexport const b = 3;\n');
    repo.commit('two', T0 + DAY);
    const git = new Git(repo.root);
    const commands: string[] = [];
    const run = git.run.bind(git);
    git.run = (args, stdin) => {
      commands.push(args.join(' '));
      return run(args, stdin);
    };
    await new Resolver(git, new TraceStore(repo.records)).resolveFile({ file: 'human.ts', text: repo.read('human.ts') });
    expect(commands.filter((command) => /^show [0-9a-f]+:/.test(command))).toEqual([]);
  });

  it('resolves a 5,000-line file with 20k edit records in under two seconds', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `export const value${i} = compute(${i});`);
    repo.write('big.ts', lines.join('\n') + '\n');
    repo.commit('base', T0 - DAY);
    for (let i = 0; i < 20_000; i++) {
      repo.addEdit({ file: i < 5000 ? 'big.ts' : `other${i % 50}.ts`, start: (i % 5000) + 1, lines: [lines[i % 5000]], ts: T0 - 2 * DAY });
    }
    const started = performance.now();
    const all = await repo.resolver().resolveFile({ file: 'big.ts', text: repo.read('big.ts') });
    const elapsed = performance.now() - started;
    expect(all.filter((entry) => entry.confidence === 'exact').length).toBe(5000);
    expect(elapsed).toBeLessThan(2000);
  }, 60_000);
});

describe('file summary', () => {
  it('counts agent lines by model and leaves blank lines out', async () => {
    mixedFile();
    const text = repo.read('src/app.ts');
    const all = await repo.resolver().resolveFile({ file: 'src/app.ts', text });
    const summary = summarize(all, text.split('\n'));
    // 14 lines, 2 blank. Opus: total() (4, one modified) + shipping() from the trailer (3). Sonnet: tax() (3).
    expect(summary).toEqual({
      total: 12,
      agent: 10,
      percent: 83,
      groups: [
        { label: 'Claude Opus 5.5', lines: 7, modified: 1, commit: 3 },
        { label: 'Claude Sonnet 5.5', lines: 3, modified: 0, commit: 0 },
      ],
    });
    expect(statusText(summary)).toBe('✦ 83% agent');
    expect(legendRows(summary)).toEqual([
      { owner: 'Claude Opus 5.5', label: 'Claude Opus 5.5', description: '7 lines (1 edited by hand since, 3 from commit messages only)' },
      { owner: 'Claude Sonnet 5.5', label: 'Claude Sonnet 5.5', description: '3 lines' },
      { label: 'No agent recorded', description: '2 lines' },
    ]);
    expect(all.map((entry) => ownerOf(entry)?.kind ?? '-').join(' ')).toBe('- agent modified agent agent - agent agent agent commit commit commit commit -');
  });

  it("doesn't round a few agent lines down to 0%", () => {
    const agent: Attribution = { line: 1, confidence: 'commit', commit: { sha: 'a', author: 'x', time: 0, summary: '', trailers: { coAuthor: 'Claude' } }, history: [] };
    const human: Attribution = { line: 2, confidence: 'none', history: [] };
    const attributions = [agent, ...Array.from({ length: 400 }, () => human)];
    expect(statusText(summarize(attributions, attributions.map(() => 'x')))).toBe('✦ <1% agent');
    expect(statusText(summarize([], []))).toBe('✦ 0% agent');
  });

  it('keeps a model on one line and one color slot', () => {
    const odd: Attribution = { line: 1, confidence: 'commit', commit: { sha: 'a', author: 'x', time: 0, summary: '', trailers: { coAuthor: 'Claude\n$(alert) **x**' } }, history: [] };
    expect(ownerOf(odd)?.label).toBe('Claude $(alert) **x**');
    const slots = new ColorSlots(2);
    expect([slots.of('a'), slots.of('b'), slots.of('a'), slots.of('c')]).toEqual([0, 1, 0, 0]);
  });

  it('draws the heatmap bar in the gutter, its pattern showing the confidence', () => {
    const rects = (svg: string) => svg.match(/<rect /g)?.length;
    expect(rects(heatmapBarSvg('#5aa9f0', 'agent'))).toBe(1);
    expect(rects(heatmapBarSvg('#5aa9f0', 'modified'))).toBe(2);
    expect(rects(heatmapBarSvg('#5aa9f0', 'commit'))).toBe(4);
    // Every segment sits at the right edge of the icon, away from the breakpoint.
    expect(heatmapBarSvg('#5aa9f0', 'commit').match(/x="(\d+)"/g)).toEqual(Array(4).fill('x="13"'));
    expect(heatmapBarSvg('#5aa9f0', 'agent')).toContain('fill="#5aa9f0"');
  });
});

describe('agent threads of a file', () => {
  it('lists each thread once, newest first, with its edits', () => {
    mixedFile();
    repo.addEdit({ file: 'src/app.ts', lines: ['  return total * 2;'], ts: T0 + 10 * MINUTE, tool_use_id: 'toolu_2' });
    const store = new TraceStore(repo.records);
    store.refresh();
    const edits = store.editsFor('src/app.ts');
    expect(edits.length).toBe(3);
    expect(store.files()).toEqual(['src/app.ts']);
    expect(store.hasEdits('src/app.ts')).toBe(true);
    expect(store.hasEdits('src/other.ts')).toBe(false);

    // The same records listed twice (a renamed file) count once.
    const threads = fileThreads([...edits, ...edits], (id) => store.turn(id), T0 + 3 * 60 * MINUTE);
    expect(threads.map(({ label, description, tooltip }) => ({ label, description, tooltip }))).toEqual([
      { label: 'Add tax', description: '1 edit · Claude Sonnet 5.5 · 2h ago', tooltip: 'Add tax' },
      {
        label: 'Add a total() helper',
        description: '2 edits · Claude Opus 5.5 · 2h ago',
        tooltip: 'Add a total() helper\nthat multiplies price by quantity',
      },
    ]);
    expect(threads[1].edits.map((row) => `${row.label} / ${row.description}`)).toEqual(['Edit · 1 line / 2h ago', 'Edit · lines 2–5 / 3h ago']);
    expect(threads[1].newest.tool_use_id).toBe('toolu_2');
    expect(threads[0].edits[0].label).toBe('Write · lines 7–9');
  });

  it('names a thread by its session when no prompt was stored', () => {
    repo.addTurn({ id: `${SESSION}:p1`, prompt: '', origin: 'agent' });
    const edit = repo.addEdit({ file: 'a.ts', start: 1, lines: ['x = 1'], ts: T0 });
    const [thread] = fileThreads([edit], () => undefined, T0);
    expect(thread.label).toBe('Session 5ee691c3');
    expect(thread.tooltip).toBe('No prompt was recorded for this thread.');
  });
});

describe('Agent Trace export', () => {
  it('writes one record per conversation, with ranges as they are at HEAD and no prompts', async () => {
    mixedFile();
    // An uncommitted change must not move the exported ranges: they refer to HEAD.
    repo.write('src/app.ts', '// typed, not committed\n' + repo.read('src/app.ts'));
    const head = repo.git('rev-parse', 'HEAD');
    const store = new TraceStore(repo.records);
    const git = new Git(repo.root);
    const result = await collectAgentTrace(git, store, new Resolver(git, store));
    expect(result).toBeDefined();
    const { records, totals, revision, skipped } = result!;
    expect(revision).toBe(head);
    expect(skipped).toBe(0);
    expect(totals).toEqual({ records: 3, files: 1, ranges: 5, lines: 11 });

    const bySession = (id: string | undefined) => records.find((record) => (record.metadata[METADATA_KEY] as { session_id?: string }).session_id === id)!;
    const opus = bySession(SESSION);
    expect(opus).toMatchObject({
      version: '0.1.0',
      timestamp: new Date(T0).toISOString(),
      vcs: { type: 'git', revision: head },
      tool: { name: 'claude-code', version: '2.1.325' },
      metadata: { [METADATA_KEY]: { source: 'record', session_id: SESSION } },
    });
    expect(opus.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(opus.files).toEqual([
      {
        path: 'src/app.ts',
        conversations: [
          {
            url: 'https://claude.ai/code/session_one',
            contributor: { type: 'ai', model_id: 'anthropic/claude-opus-5-5' },
            ranges: [
              { start_line: 2, end_line: 2 },
              { start_line: 4, end_line: 5 },
            ],
          },
          // The line Dana changed after the agent wrote it.
          { url: 'https://claude.ai/code/session_one', contributor: { type: 'mixed', model_id: 'anthropic/claude-opus-5-5' }, ranges: [{ start_line: 3, end_line: 3 }] },
        ],
      },
    ]);
    expect(bySession(OTHER_SESSION).files[0].conversations).toEqual([
      { contributor: { type: 'ai', model_id: 'anthropic/claude-sonnet-5-5' }, ranges: [{ start_line: 7, end_line: 9 }] },
    ]);
    const cloud = bySession(undefined);
    expect(cloud.tool).toBeUndefined();
    expect(cloud.metadata).toEqual({ [METADATA_KEY]: { source: 'commit-trailer' } });
    expect(cloud.files[0].conversations).toEqual([
      { url: 'https://claude.ai/code/session_cloud', contributor: { type: 'ai' }, ranges: [{ start_line: 10, end_line: 13 }] },
    ]);

    const written = JSON.stringify(records);
    expect(written).not.toContain('Add a total() helper');
    expect(written).not.toContain('Add tax');
    expect(written).not.toContain(repo.tmp);
  });

  it('leaves out files that are not at HEAD, and has nothing to say before the first commit', async () => {
    const store = new TraceStore(repo.records);
    const git = new Git(repo.root);
    repo.addEdit({ file: 'gone.ts', start: 1, lines: TOTAL, ts: T0 });
    expect(await collectAgentTrace(git, store, new Resolver(git, store))).toBeUndefined();
    repo.write('kept.ts', 'export const kept = true;\n');
    repo.commit('base', T0 + DAY);
    const result = await collectAgentTrace(git, store, new Resolver(git, store));
    expect(result).toMatchObject({ records: [], skipped: 1, cancelled: false });
  });

  it('stops when cancelled', async () => {
    mixedFile();
    const store = new TraceStore(repo.records);
    const git = new Git(repo.root);
    const abort = new AbortController();
    abort.abort();
    const result = await collectAgentTrace(git, store, new Resolver(git, store), { signal: abort.signal });
    expect(result).toMatchObject({ records: [], cancelled: true });
  });

  it('replaces its own records for the same revision and keeps everything else', () => {
    const attribution = (line: number): Attribution => ({
      line,
      confidence: 'commit',
      commit: { sha: 'c', author: 'x', time: 100, summary: '', trailers: { coAuthor: 'Claude' } },
      history: [],
    });
    let n = 0;
    const build = (revision: string, lines: number) =>
      buildTraceRecords(revision, [{ path: 'a.ts', attributions: Array.from({ length: lines }, (_, i) => attribution(i + 1)) }], () => `id-${++n}`);
    const foreign = '{"version":"0.1.0","id":"x","vcs":{"type":"git","revision":"rev2"},"files":[]}';
    const first = mergeTraceFile(`${foreign}\nnot json\n`, build('rev1', 2), 'rev1');
    const second = mergeTraceFile(first, build('rev2', 3), 'rev2');
    const third = mergeTraceFile(second, build('rev2', 4), 'rev2');
    const lines = third.trimEnd().split('\n');
    expect(lines.slice(0, 2)).toEqual([foreign, 'not json']);
    expect(lines.slice(2).map((line) => JSON.parse(line).id)).toEqual(['id-1', 'id-3']);
    expect(traceTotals(lines.slice(2).map((line) => JSON.parse(line)))).toEqual({ records: 2, files: 1, ranges: 2, lines: 6 });
    expect(third.endsWith('\n')).toBe(true);

    const file = writeAgentTrace(repo.root, build('rev3', 1), 'rev3');
    expect(path.relative(repo.root, file).split(path.sep).join('/')).toBe(AGENT_TRACE_FILE);
    writeAgentTrace(repo.root, build('rev3', 1), 'rev3');
    expect(readFileSync(file, 'utf8').trimEnd().split('\n').length).toBe(1);
  });

  it('writes model ids in provider/model form', () => {
    expect(modelId('claude-opus-5-5')).toBe('anthropic/claude-opus-5-5');
    expect(modelId('claude-opus-5-5[1m]')).toBe('anthropic/claude-opus-5-5');
    expect(modelId('openai/gpt-x')).toBe('openai/gpt-x');
    expect(modelId('some-model')).toBe('some-model');
    expect(modelId(undefined)).toBeUndefined();
  });
});

describe('capture settings file', () => {
  const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

  it("doesn't create a file while nothing is set", () => {
    expect(mergeCaptureConfig(undefined, {}, false)).toEqual({ invalid: [] });
    expect(mergeCaptureConfig(undefined, {}, true)).toEqual({ invalid: [] });
  });

  it('writes what the user set and keeps the rest of the file', () => {
    expect(mergeCaptureConfig(undefined, { prompt: 'firstLine' }, false).text).toBe(pretty({ prompt: 'firstLine' }));
    const existing = pretty({ prompt: 'none', redact: ['hand-written'], other: 1 });
    // On activation an unset setting leaves a hand-edited file alone.
    expect(mergeCaptureConfig(existing, {}, false)).toEqual({ invalid: [] });
    expect(mergeCaptureConfig(existing, { redact: ['ACME-\\d+'] }, false).text).toBe(pretty({ prompt: 'none', redact: ['ACME-\\d+'], other: 1 }));
    // After the user resets a setting, its key goes and the hook's default applies.
    expect(mergeCaptureConfig(existing, { redact: ['ACME-\\d+'] }, true).text).toBe(pretty({ redact: ['ACME-\\d+'], other: 1 }));
    expect(mergeCaptureConfig(pretty({ prompt: 'none' }), {}, true).text).toBe(pretty({}));
  });

  it('ignores values of the wrong type and reports patterns that are not regular expressions', () => {
    expect(mergeCaptureConfig(undefined, { prompt: 'everything', redact: 'x' }, false)).toEqual({ invalid: [] });
    const update = mergeCaptureConfig(undefined, { redact: ['ok', '(', 7, ''] }, false);
    expect(update.invalid).toEqual(['(']);
    expect(update.text).toBe(pretty({ redact: ['ok', '('] }));
  });

  it('leaves a file it cannot read alone unless there is something to write', () => {
    expect(mergeCaptureConfig('{ broken', {}, false)).toEqual({ invalid: [] });
    expect(mergeCaptureConfig('[1]', {}, true)).toEqual({ invalid: [] });
    expect(mergeCaptureConfig('{ broken', { prompt: 'none' }, false).text).toBe(pretty({ prompt: 'none' }));
  });

  it('is read by the hook', () => {
    const home = path.join(repo.tmp, 'home');
    expect(syncCaptureConfig(home, {}, false).written).toBe(false);
    expect(existsSync(home)).toBe(false);
    expect(syncCaptureConfig(home, { prompt: 'firstLine', redact: ['ACME-\\d+'] }, false).written).toBe(true);
    expect(syncCaptureConfig(home, { prompt: 'firstLine', redact: ['ACME-\\d+'] }, false).written).toBe(false);
    const config = loadConfig({ THREAD_TRACE_HOME: home });
    expect(config.prompt).toBe('firstLine');
    expect(config.redact.map((pattern) => pattern.source)).toEqual(['ACME-\\d+']);

    // And by the built hook itself.
    mkdirSync(path.join(repo.root, 'src'), { recursive: true });
    writeFileSync(path.join(repo.root, 'src', 'a.ts'), 'x\n');
    const payload = { session_id: SESSION, prompt_id: 'p9', cwd: repo.root, prompt: 'Fix ticket ACME-1234 please\nsecond line', hook_event_name: 'UserPromptSubmit' };
    const run = spawnSync(process.execPath, [bundle, 'prompt'], { input: JSON.stringify(payload), env: { ...process.env, THREAD_TRACE_HOME: home }, timeout: 5000 });
    expect(run.status).toBe(0);
    expect(run.stdout.toString()).toBe('');
    const turn = JSON.parse(readFileSync(path.join(repo.records, 'turns.jsonl'), 'utf8').trim().split('\n').pop()!);
    expect(turn.prompt).toBe('Fix ticket [REDACTED] please');
  });
});
