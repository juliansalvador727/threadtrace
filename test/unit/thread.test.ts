import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { claudeCode } from '../../src/adapters/claudeCode';
import type { Thread } from '../../src/adapters/types';
import type { Edit, Turn } from '../../src/store/schema';
import { escapeHtml, renderThreadHtml, threadTitle, toolSummary } from '../../src/ui/threadHtml';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'tt-thread-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const SESSION = '5ee691c3-5633-469f-a05c-3998c3b459d2';
const ROOT = '/home/user/demo-repo';
let uuid = 0;

// Entry shapes as observed in transcripts from CLI 2.1.325 (docs/SPEC.md,
// "Capture: verified differences" and "M3 decisions").
const common = () => ({ uuid: `uuid-${++uuid}`, sessionId: SESSION, version: '2.1.325', gitBranch: 'main', timestamp: '2026-11-15T19:44:23.586Z' });
const prompt = (text: string, extra: object = { promptSource: 'typed', origin: { kind: 'human' } }) => ({
  ...common(),
  type: 'user',
  message: { role: 'user', content: text },
  ...extra,
});
const assistant = (block: object) => ({ ...common(), type: 'assistant', message: { model: 'claude-opus-5-5', role: 'assistant', content: [block] } });
const toolUse = (id: string, name: string, input: object) => assistant({ type: 'tool_use', id, name, input });
const toolResult = (id: string, toolUseResult?: unknown, isError = false) => ({
  ...common(),
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok', ...(isError ? { is_error: true } : {}) }] },
  ...(toolUseResult === undefined ? {} : { toolUseResult }),
});

function transcript(name: string, entries: unknown[]): string {
  const file = path.join(tmp, name);
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  return file;
}

const editPatch = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' alpha', '-beta', '+BETA', '+BETA2', ' gamma'] }];

const main = transcript('main.jsonl', [
  { type: 'mode', mode: 'default' },
  prompt('<local-command-caveat>ignore</local-command-caveat>', { isMeta: true }),
  prompt('/clear', {}),
  prompt('Rename beta\nand keep the rest'),
  assistant({ type: 'thinking', thinking: 'secret reasoning' }),
  assistant({ type: 'text', text: 'I will look first.' }),
  toolUse('toolu_read', 'Read', { file_path: `${ROOT}/src/a.txt` }),
  toolResult('toolu_read', { type: 'text', file: {} }),
  toolUse('toolu_grep', 'Grep', { pattern: 'beta' }),
  toolResult('toolu_grep', 'str'),
  toolUse('toolu_bash', 'Bash', { command: 'npm test\necho done' }),
  toolResult('toolu_bash', { stdout: '', stderr: 'boom' }, true),
  { type: 'api-request', params: { model: 'claude-opus-5-5' } },
  toolUse('toolu_edit', 'Edit', { file_path: `${ROOT}/src/a.txt`, old_string: 'beta', new_string: 'BETA\nBETA2' }),
  toolResult('toolu_edit', { filePath: `${ROOT}/src/a.txt`, oldString: 'beta', newString: 'BETA\nBETA2', structuredPatch: editPatch }),
  toolUse('toolu_create', 'Write', { file_path: `${ROOT}/src/new.txt`, content: 'one\ntwo\n' }),
  toolResult('toolu_create', { type: 'create', filePath: `${ROOT}/src/new.txt`, content: 'one\ntwo\n', structuredPatch: [] }),
  toolUse('toolu_rewrite', 'Write', { file_path: `${ROOT}/src/a.txt`, content: 'whole\nfile\n' }),
  toolResult('toolu_rewrite', { type: 'update', filePath: `${ROOT}/src/a.txt`, structuredPatch: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, lines: ['-BETA', '+file'] }] }),
  toolUse('toolu_rejected', 'Edit', { file_path: `${ROOT}/src/a.txt`, old_string: 'x', new_string: 'y' }),
  toolResult('toolu_rejected', 'The user rejected this edit', true),
  toolUse('toolu_pending', 'Edit', { file_path: `${ROOT}/src/a.txt`, old_string: 'gamma', new_string: 'GAMMA' }),
  prompt('<task-notification>done</task-notification>', { promptSource: 'system', origin: { kind: 'task-notification' } }),
  assistant({ type: 'text', text: 'All done.' }),
  'not an object',
]);

describe('claudeCode.readThread', () => {
  const thread = claudeCode.readThread(main)!;
  const kinds = thread.items.map((item) => (item.kind === 'tool' ? `tool:${item.name}` : item.kind === 'edit' ? `edit:${item.id}` : item.kind));

  it('keeps prompts, assistant text, tool calls and edits, in order', () => {
    expect(kinds).toEqual([
      'prompt',
      'text',
      'tool:Read',
      'tool:Grep',
      'tool:Bash',
      'edit:toolu_edit',
      'edit:toolu_create',
      'edit:toolu_rewrite',
      'edit:toolu_rejected',
      'edit:toolu_pending',
      'prompt',
      'text',
    ]);
    expect(thread).toMatchObject({ session_id: SESSION, branch: 'main', version: '2.1.325', started: '2026-11-15T19:44:23.586Z' });
  });

  it('takes typed prompts as human and system prompts as agent, without their text', () => {
    expect(thread.items[0]).toMatchObject({ kind: 'prompt', origin: 'human', text: 'Rename beta\nand keep the rest' });
    expect(thread.items[10]).toMatchObject({ kind: 'prompt', origin: 'agent', text: '' });
  });

  it('categorizes tool calls and marks the failed one', () => {
    expect(thread.items[2]).toMatchObject({ category: 'read', detail: `${ROOT}/src/a.txt`, failed: false });
    expect(thread.items[3]).toMatchObject({ category: 'search', detail: 'beta' });
    expect(thread.items[4]).toMatchObject({ category: 'command', detail: 'npm test', failed: true });
  });

  it("uses the tool result's patch for edits, and the content for created files", () => {
    const edit = (id: string) => thread.items.find((item) => item.kind === 'edit' && item.id === id);
    expect(edit('toolu_edit')).toMatchObject({ tool: 'Edit', file: `${ROOT}/src/a.txt`, patch: editPatch, failed: false });
    expect(edit('toolu_create')).toMatchObject({ created: 'one\ntwo\n', patch: [] });
    // A Write over an existing file shows what changed, not the whole file.
    const rewrite = edit('toolu_rewrite');
    expect(rewrite).toMatchObject({ patch: [{ newStart: 2, lines: ['-BETA', '+file'] }] });
    expect(rewrite && 'created' in rewrite ? rewrite.created : undefined).toBeUndefined();
  });

  it('marks a rejected edit, and rebuilds a diff for a call with no result yet', () => {
    const edit = (id: string) => thread.items.find((item) => item.kind === 'edit' && item.id === id);
    expect(edit('toolu_rejected')).toMatchObject({ failed: true });
    expect(edit('toolu_pending')).toMatchObject({ failed: false, patch: [{ newStart: 0, lines: ['-gamma', '+GAMMA'] }] });
  });

  it("reads a subagent's first entry as the task it was given", () => {
    const sub = transcript('agent-abc.jsonl', [
      prompt('Fix the tests in src/', { isSidechain: true, agentId: 'abc' }),
      { ...toolUse('toolu_sub', 'Edit', { file_path: `${ROOT}/src/a.txt`, old_string: 'a', new_string: 'b' }), isSidechain: true },
    ]);
    const items = claudeCode.readThread(sub)!.items;
    expect(items[0]).toMatchObject({ kind: 'prompt', origin: 'agent', text: 'Fix the tests in src/' });
    expect(items[1]).toMatchObject({ kind: 'edit', id: 'toolu_sub' });
  });

  it('returns undefined when the transcript is not on this machine', () => {
    expect(claudeCode.readThread(path.join(tmp, 'missing.jsonl'))).toBeUndefined();
  });
});

const resources = { cspSource: 'vscode-webview://abc', nonce: 'n0nce', styleUri: 'vscode-webview://abc/panel.css', scriptUri: 'vscode-webview://abc/panel.js' };

const turn: Turn = {
  v: 1,
  id: `${SESSION}:p1`,
  agent: { name: 'claude-code', version: '2.1.325' },
  session_id: SESSION,
  prompt: 'Rename beta',
  origin: 'human',
  ts: '2026-11-15T19:44:23.586Z',
  cwd: ROOT,
  git: { head: '', branch: 'main' },
  source: 'hook',
};
const edit: Edit = {
  v: 1,
  id: 'E1',
  turn_id: turn.id,
  session_id: SESSION,
  tool_use_id: 'toolu_edit',
  tool: 'Edit',
  model: 'claude-opus-5-5',
  file: 'src/a.txt',
  ts: turn.ts,
  hunks: [{ start: 2, end: 3, hashes: ['a', 'b'] }],
  base_head: '',
  source: 'hook',
};

describe('renderThreadHtml', () => {
  const thread = claudeCode.readThread(main)!;
  const html = renderThreadHtml({ turn, edit, thread, target: 'toolu_edit', root: ROOT, hasTranscript: true }, resources);

  it('titles the panel with the first prompt', () => {
    expect(threadTitle({ thread })).toBe('Rename beta');
    expect(threadTitle({ turn: { ...turn, prompt: 'x'.repeat(100) } })).toBe(`${'x'.repeat(60)}…`);
    expect(threadTitle({})).toBe('Agent thread');
    expect(html).toContain('<h1>Rename beta</h1>');
  });

  it('shows agent, model, session, time and branch in the header, with the buttons', () => {
    expect(html).toMatch(/<p class="meta">claude-code 2\.1\.325 · Claude Opus 5\.5 · 5ee691c3-5633-469f-a05c-3998c3b459d2 · \d{4}-\d\d-\d\d \d\d:\d\d · main<\/p>/);
    expect(html).toContain('data-action="revealTranscript"');
    expect(html).toContain('data-action="copyPrompt"');
    expect(html).not.toContain('data-action="openWeb"');
    const web = renderThreadHtml({ turn: { ...turn, thread_url: 'https://claude.ai/code/session_1' }, thread }, resources);
    expect(web).toContain('data-action="openWeb"');
    expect(web).not.toContain('data-action="revealTranscript"');
  });

  it('collapses a run of tool calls into one summary', () => {
    expect(toolSummary([{ category: 'search' }, { category: 'read' }, { category: 'search' }, { category: 'search' }])).toBe('Ran 3 searches, read 1 file');
    expect(html).toContain('<summary>Read 1 file, ran 1 search, ran 1 command</summary>');
    expect(html).toContain('<span class="name">Read</span> <span class="detail">src/a.txt</span>');
    expect(html).toContain('<span class="failed">failed</span>');
  });

  it('shows edits as diffs, with paths relative to the repo, and marks the target', () => {
    expect(html).toContain('<article class="edit target" data-tool="toolu_edit">');
    expect(html).toContain('<span class="verb">Edited</span> <span class="file">src/a.txt</span>');
    expect(html).toContain('<span class="hunk">@@ line 1 @@</span>\n<span class="ctx"> alpha</span>\n<span class="del">-beta</span>\n<span class="add">+BETA</span>');
    expect(html).toContain('<span class="verb">Created</span> <span class="file">src/new.txt</span>');
    expect(html).toContain('<span class="add">+one</span>\n<span class="add">+two</span></pre>');
    expect(html).toContain('<span class="verb">Rewrote</span>');
    expect(html).toContain('<span class="failed">not applied</span>');
    expect(html.match(/class="edit target"/g)).toHaveLength(1);
    expect(html).toContain('<body data-target="toolu_edit">');
  });

  it('leaves out thinking and explains agent-submitted prompts', () => {
    expect(html).not.toContain('secret reasoning');
    expect(html).not.toContain('task-notification');
    expect(html).toContain('The agent continued on its own');
  });

  it('says so when the tool call is no longer in the transcript', () => {
    const gone = renderThreadHtml({ turn, edit, thread, target: 'toolu_gone' }, resources);
    expect(gone).toContain('isn’t in the transcript any more');
    expect(html).not.toContain('isn’t in the transcript any more');
  });

  it("appends the subagent's transcript when a subagent made the edit", () => {
    const subagent: Thread = { items: [{ kind: 'edit', id: 'toolu_sub', tool: 'Edit', file: `${ROOT}/b.txt`, patch: [], failed: false }] };
    const both = renderThreadHtml({ turn, edit, thread, subagent, target: 'toolu_sub', root: ROOT }, resources);
    expect(both).toContain('<h2 class="divider">Subagent</h2>');
    expect(both).toContain('<article class="edit target" data-tool="toolu_sub">');
    expect(both).not.toContain('isn’t in the transcript any more');
  });

  it('shows the turn record when the transcript is missing', () => {
    const missing = renderThreadHtml({ turn, edit, target: 'toolu_edit' }, resources);
    expect(missing).toContain('isn’t on this machine');
    expect(missing).toContain('<pre class="text">Rename beta</pre>');
    expect(missing).toContain('<article class="edit target" data-tool="toolu_edit">');
    expect(missing).toContain('2 lines written');
    expect(missing).not.toContain('data-action="revealTranscript"');
  });

  it('cuts very long text and diffs', () => {
    const long: Thread = {
      items: [
        { kind: 'text', id: 't', text: 'a'.repeat(9000) },
        { kind: 'edit', id: 'e', tool: 'Write', file: '/x', patch: [], created: 'line\n'.repeat(500), failed: false },
      ],
    };
    const cut = renderThreadHtml({ thread: long }, resources);
    expect(cut).toContain('… (1000 more characters)');
    expect(cut).toContain('… 100 more lines');
  });
});

// Acceptance test 10, the panel half: transcript content renders as text.
describe('10: safety', () => {
  const hostile = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
  const thread: Thread = {
    session_id: hostile,
    branch: hostile,
    version: hostile,
    items: [
      { kind: 'prompt', id: 'p', origin: 'human', text: hostile },
      { kind: 'text', id: 't', text: hostile },
      { kind: 'tool', id: hostile, category: 'other', name: hostile, detail: hostile, failed: false },
      { kind: 'edit', id: `"><script>x</script>`, tool: hostile, file: hostile, patch: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [`+${hostile}`] }], failed: false },
      { kind: 'edit', id: 'c', tool: 'Write', file: '/x', patch: [], created: hostile, failed: false },
    ],
  };
  const html = renderThreadHtml(
    {
      thread,
      turn: { ...turn, prompt: hostile, session_id: hostile, agent: { name: hostile, version: hostile }, git: { head: '', branch: hostile } },
      edit: { ...edit, model: hostile, file: hostile, tool: hostile },
      target: `"><script>x</script>`,
    },
    resources,
  );

  it('escapes every piece of transcript and record content', () => {
    expect(escapeHtml(hostile)).toBe('&lt;script&gt;alert(1)&lt;/script&gt;&lt;img src=x onerror=alert(2)&gt;&quot;&#39;&amp;');
    // The only script element is the panel's own; no markup from the content survives.
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="n0nce" src="vscode-webview://abc/panel.js"></script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    const record = renderThreadHtml({ turn: { ...turn, prompt: hostile }, edit: { ...edit, file: hostile, tool: hostile, tool_use_id: hostile } }, resources);
    expect(record.match(/<script/g)).toHaveLength(1);
    expect(record).not.toContain('<img');
  });

  it('sets a CSP that allows only the panel stylesheet and the nonce script', () => {
    expect(html).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; style-src vscode-webview://abc; script-src &#39;nonce-n0nce&#39;">`,
    );
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/\son\w+="/);
    expect(html).not.toContain('style="');
  });
});
