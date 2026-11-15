import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { looseHash, strictHash } from '../../src/store/hash';
import type { Edit, Turn } from '../../src/store/schema';

const BACKFILL_LINES = ['export function discount(price: number, percent: number) {', '  return price - (price * percent) / 100;', '}'];
const CLOUD_LINES = ['export function shipping(weight: number) {', '  return weight > 10 ? 15 : 5;', '}'];
const AGENT_LINES = ['export function total(price: number, quantity: number) {', '  return price * quantity;', '}'];

/**
 * A temp git repo for the tests to open as their workspace: one file whose
 * lines 2-4 were written by an agent (recorded and committed) and whose last
 * line was typed by hand. The session's transcript sits beside the repo.
 * For M4 it also has `backfilled.ts`, written by a session that left only a
 * transcript under `claude/projects/` (no records), and `cloud.ts`, whose
 * commit carries agent trailers and nothing else.
 * Returns the temp dir; the repo is its `repo` folder.
 */
function seedWorkspace(): string {
  const base = mkdtempSync(path.join(os.tmpdir(), 'tt-integration-'));
  // A hook script left by an older version: activation should replace it with this build's.
  mkdirSync(path.join(base, 'home', 'bin'), { recursive: true });
  writeFileSync(path.join(base, 'home', 'bin', 'tt-capture.js'), '// tt-capture from an older version\n');
  const root = path.join(base, 'repo');
  mkdirSync(root);
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_AUTHOR_NAME: 'Julian',
    GIT_AUTHOR_EMAIL: 'julian@example.com',
    GIT_COMMITTER_NAME: 'Julian',
    GIT_COMMITTER_EMAIL: 'julian@example.com',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, env, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'app.ts'), ['// app', ...AGENT_LINES, 'export const typedByHand = total(2, 3);', ''].join('\n'));

  const session = 'integration-session';
  const ts = new Date(Date.now() - 60_000).toISOString();
  const toolUseId = 'toolu_integration_edit';
  const appFile = path.join(root, 'app.ts');
  const entry = { sessionId: session, version: '2.1.325', gitBranch: 'main', timestamp: ts };
  const filler = Array.from({ length: 80 }, (_, i) => `Step ${i}: looking around.`);
  const transcript = path.join(base, 'transcript.jsonl');
  writeFileSync(
    transcript,
    [
      { ...entry, type: 'user', uuid: 'u1', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: 'Add a total helper' } },
      // Enough text above the edit that the panel has to scroll to reach it.
      ...filler.map((text, i) => ({ ...entry, type: 'assistant', uuid: `a${i}`, message: { model: 'claude-opus-5-5', content: [{ type: 'text', text }] } })),
      { ...entry, type: 'assistant', uuid: 'r1', message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: 'toolu_read', name: 'Read', input: { file_path: appFile } }] } },
      { ...entry, type: 'user', uuid: 'r2', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_read', content: '// app' }] } },
      {
        ...entry,
        type: 'assistant',
        uuid: 'e1',
        message: { model: 'claude-opus-5-5', content: [{ type: 'tool_use', id: toolUseId, name: 'Edit', input: { file_path: appFile, old_string: '', new_string: AGENT_LINES.join('\n') } }] },
      },
      {
        ...entry,
        type: 'user',
        uuid: 'e2',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
        toolUseResult: {
          filePath: appFile,
          structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 4, lines: [' // app', ...AGENT_LINES.map((line) => `+${line}`)] }],
        },
      },
      { ...entry, type: 'assistant', uuid: 'z1', message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: '<script>document.title = "pwned"</script>' }] } },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );
  const turn: Turn = {
    v: 1,
    id: `${session}:p1`,
    agent: { name: 'claude-code' },
    session_id: session,
    transcript_path: transcript,
    prompt: 'Add a total helper',
    origin: 'human',
    ts,
    cwd: root,
    git: { head: '' },
    source: 'hook',
  };
  const edit: Edit = {
    v: 1,
    id: 'INTEGRATION0001',
    turn_id: turn.id,
    session_id: session,
    tool_use_id: toolUseId,
    tool: 'Edit',
    model: 'claude-opus-5-5',
    file: 'app.ts',
    ts,
    hunks: [{ start: 2, end: 4, hashes: AGENT_LINES.map(strictHash), loose: AGENT_LINES.map(looseHash) }],
    base_head: '',
    source: 'hook',
  };
  const records = path.join(root, '.git', 'thread-trace');
  mkdirSync(records);
  writeFileSync(path.join(records, 'turns.jsonl'), JSON.stringify(turn) + '\n');
  writeFileSync(path.join(records, 'edits.jsonl'), JSON.stringify(edit) + '\n');

  // A session from before the hook was installed: only Claude Code's own transcript exists.
  const backfilled = path.join(root, 'backfilled.ts');
  const content = BACKFILL_LINES.join('\n') + '\n';
  writeFileSync(backfilled, content);
  const old = { sessionId: 'backfill-session', version: '2.1.325', gitBranch: 'main', timestamp: ts, cwd: root, promptId: 'backfill-prompt' };
  const project = path.join(base, 'claude', 'projects', root.replace(/[^A-Za-z0-9]/g, '-'));
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, 'backfill-session.jsonl'),
    [
      { ...old, type: 'user', uuid: 'b1', promptSource: 'typed', origin: { kind: 'human' }, message: { role: 'user', content: 'Add a discount helper' } },
      {
        ...old,
        type: 'assistant',
        uuid: 'b2',
        message: { model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'toolu_backfill_write', name: 'Write', input: { file_path: backfilled, content } }] },
      },
      {
        ...old,
        type: 'user',
        uuid: 'b3',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_backfill_write', content: 'ok' }] },
        toolUseResult: { type: 'create', filePath: backfilled, content, structuredPatch: [], originalFile: null },
      },
    ]
      .map((line) => JSON.stringify(line))
      .join('\n') + '\n',
  );

  git('add', '-A');
  git('commit', '-q', '-m', 'Add total helper');

  // A commit from a cloud session: trailers in the message, no records here.
  writeFileSync(path.join(root, 'cloud.ts'), CLOUD_LINES.join('\n') + '\n');
  git('add', '-A');
  git(
    'commit',
    '-q',
    '-m',
    'Add shipping helper\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_integration',
  );
  return base;
}

// Downloads VS Code if needed, launches it with this extension loaded, and
// runs the mocha suite inside the Extension Development Host.
async function main(): Promise<void> {
  // Bundled to out/test/integration/runTest.js, so the repo root is three levels up.
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  const base = seedWorkspace();
  const workspace = path.join(base, 'repo');
  try {
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      // Trust the temp workspace: the read side is off in untrusted ones.
      launchArgs: [workspace, '--disable-workspace-trust'],
      extensionTestsEnv: {
        THREAD_TRACE_TEST_WORKSPACE: workspace,
        // Backfill reads transcripts from here, never from the real ~/.claude or ~/.thread-trace.
        CLAUDE_CONFIG_DIR: path.join(base, 'claude'),
        THREAD_TRACE_HOME: path.join(base, 'home'),
      },
    });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
