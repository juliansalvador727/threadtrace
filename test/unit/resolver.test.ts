import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { annotationText, renderCard } from '../../src/ui/hoverCard';
import { DAY, MINUTE, SESSION, T0, TestRepo } from './helpers/repo';

// Resolver tests against real git repos. Numbers refer to the acceptance
// tests in docs/SPEC.md.
const bundle = path.resolve(__dirname, '../../dist/tt-capture.js');

let repo: TestRepo;
beforeEach(() => {
  repo = new TestRepo();
});
afterEach(() => repo.dispose());

const AGENT_BLOCK = ['export function total(price: number, quantity: number) {', '  const total = price * quantity;', '  return total;', '}'];

/** A base commit, then an agent edit (recorded) committed five minutes later. */
function agentCommit(): { sha: string } {
  repo.write('src/app.ts', '// app\n');
  repo.commit('base', T0 - DAY);
  repo.write('src/app.ts', ['// app', ...AGENT_BLOCK, ''].join('\n'));
  repo.addTurn({ id: `${SESSION}:p1`, prompt: 'Add a total() helper\nthat multiplies price by quantity' });
  repo.addEdit({ file: 'src/app.ts', start: 2, lines: AGENT_BLOCK, ts: T0, tool_use_id: 'toolu_1' });
  return { sha: repo.commit('Add total helper', T0 + 5 * MINUTE) };
}

describe('1: exact attribution', () => {
  it('attributes a committed agent line with its prompt, model and commit', async () => {
    const { sha } = agentCommit();
    const found = await repo.resolve('src/app.ts', 3);
    expect(found.confidence).toBe('exact');
    expect(found.edit?.model).toBe('claude-opus-5-5');
    expect(found.turn?.prompt).toContain('Add a total() helper');
    expect(found.commit).toMatchObject({ sha, author: 'Julian', summary: 'Add total helper' });

    const now = T0 + 2 * 60 * MINUTE;
    expect(annotationText(found, now)).toBe('✦ Claude Opus 5.5 · 2h ago · 1 thread');
    const card = renderCard(found, { now, file: 'src/app.ts' }).markdown;
    expect(card).toContain('**Line 3**');
    expect(card).toContain('Claude Opus 5\\.5');
    expect(card).toContain('Add a total\\(\\) helper');
    expect(card).toContain('exact');
    expect(card).toContain('Add total helper');
    expect(card).toContain('1 thread · 1 commit');
  });

  it('works end to end from the built hook, and takes the model from the transcript', async () => {
    const home = path.join(repo.tmp, 'home');
    const transcript = path.join(repo.tmp, 'transcripts', `${SESSION}.jsonl`);
    mkdirSync(path.dirname(transcript), { recursive: true });
    // At hook time only the request is on disk, and it names another model.
    writeFileSync(transcript, JSON.stringify({ type: 'api-request', params: { model: 'claude-haiku-5-5' } }) + '\n');
    const file = path.join(repo.root, 'src/new.ts');
    const content = 'export const answer = computeAnswer(42);\n';
    const common = { session_id: SESSION, transcript_path: transcript, cwd: repo.root, prompt_id: 'p9' };
    const hook = (mode: string, payload: object) => {
      const run = spawnSync(process.execPath, [bundle, mode], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, THREAD_TRACE_HOME: home },
      });
      expect(run.status).toBe(0);
    };
    hook('prompt', { ...common, hook_event_name: 'UserPromptSubmit', prompt: 'Export the answer' });
    repo.write('src/new.ts', content);
    hook('edit', {
      ...common,
      hook_event_name: 'PostToolUse',
      tool_name: 'Write',
      tool_input: { file_path: file, content },
      tool_response: { type: 'create', filePath: file, content, structuredPatch: [] },
      tool_use_id: 'toolu_write',
    });
    // The assistant entry reaches the transcript after the hook ran.
    const assistant = {
      type: 'assistant',
      message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_write', name: 'Write', input: {} }] },
    };
    appendFileSync(transcript, JSON.stringify(assistant) + '\n');
    repo.commit('Add answer', Date.now());

    const found = await repo.resolve('src/new.ts', 1);
    expect(found.confidence).toBe('exact');
    expect(found.edit?.model).toBe('claude-opus-5-5');
    expect(found.turn?.prompt).toBe('Export the answer');
    expect(found.commit?.summary).toBe('Add answer');
  });
});

describe('2: uncommitted', () => {
  it('attributes an agent line in a file git has never seen', async () => {
    repo.write('README.md', 'hi\n');
    repo.commit('base', T0 - DAY);
    repo.write('src/app.ts', AGENT_BLOCK.join('\n') + '\n');
    repo.addTurn({ id: `${SESSION}:p1` });
    repo.addEdit({ file: 'src/app.ts', start: 1, lines: AGENT_BLOCK, ts: T0, tool: 'Write' });

    const found = await repo.resolve('src/app.ts', 2);
    expect(found.confidence).toBe('exact');
    expect(found.commit).toBeUndefined();
    expect(renderCard(found, { now: T0 + MINUTE }).markdown).toContain('Not committed yet');
  });

  it('works in a repo with no commits at all', async () => {
    repo.write('src/app.ts', AGENT_BLOCK.join('\n') + '\n');
    repo.addEdit({ file: 'src/app.ts', start: 1, lines: AGENT_BLOCK, ts: T0 });
    expect((await repo.resolve('src/app.ts', 2)).confidence).toBe('exact');
  });

  it('keeps the attribution when an unrelated commit lands after the edit', async () => {
    repo.write('src/app.ts', '// app\n');
    repo.commit('base', T0 - DAY);
    repo.write('src/app.ts', ['// app', ...AGENT_BLOCK, ''].join('\n'));
    repo.addEdit({ file: 'src/app.ts', start: 2, lines: AGENT_BLOCK, ts: T0 });
    // HEAD moves past the edit's time while the agent's lines stay uncommitted.
    repo.git('stash', '-q');
    repo.write('other.txt', 'unrelated\n');
    repo.commit('unrelated', T0 + 60 * MINUTE);
    repo.git('stash', 'pop', '-q');

    const found = await repo.resolve('src/app.ts', 3);
    expect(found.confidence).toBe('exact');
    expect(found.commit).toBeUndefined();
  });

  it('resolves an unsaved buffer with the line numbers on screen', async () => {
    agentCommit();
    const buffer = ['// typed, not saved', ...repo.read('src/app.ts').split('\n')].join('\n');
    const resolver = repo.resolver();
    const typed = await resolver.resolve({ file: 'src/app.ts', line: 1, text: buffer });
    expect(typed).toMatchObject({ confidence: 'none', commit: undefined });
    const agent = await resolver.resolve({ file: 'src/app.ts', line: 4, text: buffer });
    expect(agent.confidence).toBe('exact');
    expect(agent.commit?.summary).toBe('Add total helper');
  });
});

describe('3: human tweak', () => {
  it('reports a renamed variable as modified, with the human commit and the agent edit', async () => {
    agentCommit();
    repo.write('src/app.ts', repo.read('src/app.ts').replace('const total = price', 'const sum = price'));
    const human = repo.commit('Rename total to sum', T0 + DAY, 'Dana');

    const found = await repo.resolve('src/app.ts', 3);
    expect(found.confidence).toBe('modified');
    expect(found.commit).toMatchObject({ sha: human, author: 'Dana' });
    expect(found.edit?.tool_use_id).toBe('toolu_1');

    const now = T0 + 2 * DAY;
    expect(annotationText(found, now)).toBe('Dana, Yesterday · 1 thread');
    const card = renderCard(found, { now }).markdown;
    // The user's commit comes first, the agent thread second.
    expect(card.indexOf('Rename total to sum')).toBeLessThan(card.indexOf('Originally written by'));
    expect(card).toContain('modified');
  });

  it('reports a re-indented line as modified through the loose hash', async () => {
    agentCommit();
    repo.write('src/app.ts', repo.read('src/app.ts').replace('  const total', '\t\tconst  total'));
    repo.commit('Reformat', T0 + DAY, 'Dana');
    expect((await repo.resolve('src/app.ts', 3)).confidence).toBe('modified');
  });

  it("doesn't call a new, similar line modified while the agent's line is still there", async () => {
    agentCommit();
    repo.write('src/app.ts', repo.read('src/app.ts').replace('  return total;', '  const total2 = price * quantity;\n  return total;'));
    repo.commit('Add a similar line', T0 + DAY, 'Dana');
    expect((await repo.resolve('src/app.ts', 3)).confidence).toBe('exact');
    expect((await repo.resolve('src/app.ts', 4)).confidence).toBe('none');
  });

  it("doesn't attribute a line the agent wrote only after the commit", async () => {
    repo.write('src/app.ts', AGENT_BLOCK.join('\n') + '\n');
    repo.commit('Typed by hand', T0);
    repo.addEdit({ file: 'src/app.ts', start: 1, lines: AGENT_BLOCK, ts: T0 + 60 * MINUTE });
    expect((await repo.resolve('src/app.ts', 2)).confidence).toBe('none');
  });
});

describe('4: rebase', () => {
  it('keeps exact and modified attributions after the SHAs are rewritten', async () => {
    repo.write('src/app.ts', '// app\n');
    repo.commit('base', T0 - DAY);
    repo.git('checkout', '-q', '-b', 'feature');
    repo.write('src/app.ts', ['// app', ...AGENT_BLOCK, ''].join('\n'));
    repo.addTurn({ id: `${SESSION}:p1` });
    repo.addEdit({ file: 'src/app.ts', start: 2, lines: AGENT_BLOCK, ts: T0, tool_use_id: 'toolu_1' });
    const agentSha = repo.commit('Add total helper', T0 + 5 * MINUTE);
    repo.write('src/app.ts', repo.read('src/app.ts').replace('return total;', 'return total2;'));
    const humanSha = repo.commit('Rename the result', T0 + DAY, 'Dana');

    repo.git('checkout', '-q', 'main');
    repo.write('other.txt', 'moved on\n');
    repo.commit('main moved on', T0 + 2 * DAY);
    repo.git('checkout', '-q', 'feature');
    repo.git('rebase', '-q', 'main');

    const exact = await repo.resolve('src/app.ts', 3);
    expect(exact.confidence).toBe('exact');
    expect(exact.commit?.summary).toBe('Add total helper');
    expect(exact.commit?.sha).not.toBe(agentSha);

    const modified = await repo.resolve('src/app.ts', 4);
    expect(modified.confidence).toBe('modified');
    expect(modified.commit?.summary).toBe('Rename the result');
    expect(modified.commit?.sha).not.toBe(humanSha);
    expect(modified.edit?.tool_use_id).toBe('toolu_1');
  });
});

describe('5: weak lines', () => {
  it("gives the agent's closing brace the attribution of its block", async () => {
    agentCommit();
    const found = await repo.resolve('src/app.ts', 5);
    expect(found.confidence).toBe('exact');
    expect(found.edit?.tool_use_id).toBe('toolu_1');
    expect(found.line).toBe(5);
  });

  it("doesn't attribute a brace a human committed later", async () => {
    agentCommit();
    repo.write('src/app.ts', repo.read('src/app.ts') + 'export function other() {\n  return fetchOther();\n}\n');
    repo.commit('Add other', T0 + DAY, 'Dana');
    const found = await repo.resolve('src/app.ts', 8);
    expect(found.confidence).toBe('none');
    expect(found.commit?.author).toBe('Dana');
  });

  it("doesn't attribute a brace typed next to uncommitted agent lines", async () => {
    repo.write('src/app.ts', 'if (ready) {\n');
    repo.commit('base', T0 - DAY);
    const agent = ['  prepareEverything();', '  launchTheThing();'];
    repo.addEdit({ file: 'src/app.ts', start: 2, lines: agent, ts: T0 });
    // The agent wrote two lines; the human then closed the block by hand.
    repo.write('src/app.ts', ['if (ready) {', ...agent, '}', ''].join('\n'));
    expect((await repo.resolve('src/app.ts', 3)).confidence).toBe('exact');
    expect((await repo.resolve('src/app.ts', 4)).confidence).toBe('none');
  });
});

describe('grading', () => {
  it('drops to likely when the line has moved far from where it was written', async () => {
    agentCommit();
    const filler = Array.from({ length: 60 }, (_, i) => `// filler ${i}`);
    repo.write('src/app.ts', [...filler, repo.read('src/app.ts')].join('\n'));
    repo.commit('Add a long header', T0 + DAY, 'Dana');
    const found = await repo.resolve('src/app.ts', 63);
    expect(found.confidence).toBe('likely');
    expect(found.commit?.summary).toBe('Add total helper');
  });

  it('prefers the newest turn that wrote the line and lists the others', async () => {
    repo.write('src/app.ts', '// app\n');
    repo.commit('base', T0 - DAY);
    repo.write('src/app.ts', ['// app', ...AGENT_BLOCK, ''].join('\n'));
    repo.addTurn({ id: `${SESSION}:p1`, prompt: 'first attempt' });
    repo.addTurn({ id: 'other-session:p2', session_id: 'other-session', prompt: 'second attempt' });
    repo.addEdit({ file: 'src/app.ts', start: 2, lines: AGENT_BLOCK, ts: T0 - 30 * MINUTE });
    repo.addEdit({ file: 'src/app.ts', start: 2, lines: AGENT_BLOCK, ts: T0, turn_id: 'other-session:p2', session_id: 'other-session' });
    repo.commit('Add total helper', T0 + 5 * MINUTE);

    const found = await repo.resolve('src/app.ts', 3);
    expect(found.turn?.prompt).toBe('second attempt');
    expect(found.history.map((entry) => entry.turn?.prompt)).toEqual(['first attempt']);
    expect(annotationText(found, T0 + DAY)).toContain('2 threads');
  });

  it('adds the older commits of the line on request', async () => {
    agentCommit();
    repo.write('src/app.ts', repo.read('src/app.ts').replace('const total = price', 'const sum = price'));
    repo.commit('Rename total to sum', T0 + DAY, 'Dana');
    const resolver = repo.resolver();
    const found = await repo.resolve('src/app.ts', 3, resolver);
    const expanded = await resolver.withCommitChain(found);
    expect(expanded.history.map((entry) => entry.commit?.summary)).toEqual(['Add total helper']);
  });

  it('returns none past the last line instead of failing', async () => {
    agentCommit();
    expect((await repo.resolve('src/app.ts', 99)).confidence).toBe('none');
  });
});

describe('11: performance', () => {
  it('resolves a line of a 5,000-line file with 20k edit records in under 300 ms, cold', async () => {
    const lines = Array.from({ length: 5000 }, (_, i) => `export const value${i} = compute(${i});`);
    repo.write('src/big.ts', lines.join('\n') + '\n');
    for (let i = 0; i < 20_000; i++) {
      const start = (i * 7) % 4990;
      repo.addEdit({ file: i % 4 === 0 ? 'src/big.ts' : `src/file${i % 300}.ts`, start: start + 1, lines: lines.slice(start, start + 5), ts: T0 - i });
    }
    repo.commit('big', T0 + 5 * MINUTE);

    const started = performance.now();
    const found = await repo.resolve('src/big.ts', 2501);
    const elapsed = performance.now() - started;
    expect(found.confidence).toBe('exact');
    expect(elapsed).toBeLessThan(300);
  });
});
