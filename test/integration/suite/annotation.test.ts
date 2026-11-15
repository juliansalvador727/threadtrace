import * as assert from 'node:assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ThreadTraceApi } from '../../../src/ui/annotation';

// Runs against the repo that runTest.ts seeds: app.ts lines 2-4 were written
// by an agent and committed; line 5 was typed by hand.
describe('line annotation', () => {
  let api: ThreadTraceApi;
  let file: vscode.Uri;

  before(async () => {
    const workspace = process.env.THREAD_TRACE_TEST_WORKSPACE;
    assert.ok(workspace, 'THREAD_TRACE_TEST_WORKSPACE is not set');
    file = vscode.Uri.file(path.join(workspace, 'app.ts'));
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'thread-trace');
    assert.ok(extension, 'thread-trace extension not found');
    api = (await extension.activate()) as ThreadTraceApi;
  });

  it('registers the annotation commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['threadTrace.toggleAnnotation', 'threadTrace.copyPrompt', 'threadTrace.hoverFilter', 'threadTrace.backfill', 'threadTrace.openCommitSession']) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });

  it('shows the model, prompt and commit for an agent-written line at exact confidence', async () => {
    const result = await api.resolveLine(file, 2);
    assert.ok(result, 'the line did not resolve');
    assert.strictEqual(result.confidence, 'exact');
    assert.match(result.text, /^✦ Claude Opus 5\.5 · .* · 1 thread$/);
    assert.ok(result.markdown.includes('Add a total helper'), result.markdown);
    assert.ok(result.markdown.includes('exact'), result.markdown);
    assert.ok(result.markdown.includes('Add total helper'), result.markdown);
  });

  it('gives the closing brace the attribution of its block', async () => {
    const result = await api.resolveLine(file, 3);
    assert.strictEqual(result?.confidence, 'exact');
  });

  it('shows plain blame for a line typed by hand', async () => {
    const result = await api.resolveLine(file, 4);
    assert.strictEqual(result?.confidence, 'none');
    assert.match(result.text, /^Julian, /);
  });

  it('resolves an unsaved edit as not committed yet', async () => {
    const editor = await vscode.window.showTextDocument(file);
    await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), 'const unsaved = 1;\n'));
    const typed = await api.resolveLine(file, 0);
    assert.strictEqual(typed?.text, 'Not committed yet');
    // The agent line moved down one with the buffer.
    const agent = await api.resolveLine(file, 3);
    assert.strictEqual(agent?.confidence, 'exact');
    await vscode.commands.executeCommand('workbench.action.files.revert');
  });

  // Acceptance test 7.
  it('shows commit confidence and the session link for a line known only from its commit trailers', async () => {
    const cloud = vscode.Uri.file(path.join(path.dirname(file.fsPath), 'cloud.ts'));
    const result = await api.resolveLine(cloud, 1);
    assert.ok(result, 'the line did not resolve');
    assert.strictEqual(result.confidence, 'commit');
    assert.match(result.text, /^✦ Claude Opus 5\.5 · /);
    assert.ok(result.markdown.includes('Open on claude.ai'), result.markdown);
    assert.ok(result.markdown.includes('command:threadTrace.openCommitSession'), result.markdown);
    assert.ok(!result.markdown.includes('session_integration'), 'the URL must not be in the card');
  });

  // Acceptance test 8, through the command.
  it('backfills from transcripts, after which the lines resolve to their thread', async () => {
    const backfilled = vscode.Uri.file(path.join(path.dirname(file.fsPath), 'backfilled.ts'));
    const before = await api.resolveLine(backfilled, 1);
    assert.strictEqual(before?.confidence, 'none');

    await vscode.window.showTextDocument(backfilled);
    await vscode.commands.executeCommand('threadTrace.backfill');
    const after = await api.resolveLine(backfilled, 1);
    assert.strictEqual(after?.confidence, 'exact');
    assert.match(after.text, /^✦ Claude Sonnet 5\.5 · /);
    assert.ok(after.markdown.includes('Add a discount helper'), after.markdown);
    // The closing brace takes its block's attribution, as with hook records.
    assert.strictEqual((await api.resolveLine(backfilled, 2))?.confidence, 'exact');

    // Running it again changes nothing.
    await vscode.commands.executeCommand('threadTrace.backfill');
    assert.match((await api.resolveLine(backfilled, 1))?.text ?? '', / · 1 thread$/);
  });

  it('adds a one-line attribution to ordinary hovers only when hover.mode is "anywhere"', async () => {
    const config = vscode.workspace.getConfiguration('threadTrace');
    const hoverText = async () => {
      const hovers = await vscode.commands.executeCommand<vscode.Hover[]>('vscode.executeHoverProvider', file, new vscode.Position(2, 4));
      return hovers.flatMap((hover) => hover.contents.map((content) => (typeof content === 'string' ? content : content.value))).join('\n');
    };
    await vscode.window.showTextDocument(file);
    assert.ok(!(await hoverText()).includes('Claude Opus'), 'the hover line is on by default');
    await config.update('hover.mode', 'anywhere', vscode.ConfigurationTarget.Global);
    try {
      const text = await hoverText();
      assert.ok(text.includes('✦ Claude Opus 5\\.5'), text);
      assert.ok(text.includes('command:threadTrace.showThreadForLine'), text);
    } finally {
      await config.update('hover.mode', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.ok(!(await hoverText()).includes('Claude Opus'), 'the hover line stayed on');
  });

  it('copies the prompt behind the cursor line', async () => {
    const editor = await vscode.window.showTextDocument(file);
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('threadTrace.copyPrompt');
    assert.strictEqual(await vscode.env.clipboard.readText(), 'Add a total helper');
  });

  it('diffs a file against an empty left side in the commit that added it', async () => {
    const workspace = path.dirname(file.fsPath);
    const sha = execFileSync('git', ['log', '--format=%H', '--diff-filter=A', '--', 'app.ts'], { cwd: workspace, encoding: 'utf8' }).trim();
    const editor = await vscode.window.showTextDocument(file);
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await api.resolveLine(file, 2);
    let input: unknown;
    for (let i = 0; i < 40 && !(input instanceof vscode.TabInputTextDiff); i++) {
      await vscode.commands.executeCommand('threadTrace.openCommitDiff', sha, 'app.ts');
      input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
      if (!(input instanceof vscode.TabInputTextDiff)) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(input instanceof vscode.TabInputTextDiff, 'no diff editor opened');
    assert.strictEqual(input.original.scheme, 'thread-trace-empty');
    assert.strictEqual(input.modified.scheme, 'git');
    assert.match(vscode.window.tabGroups.activeTabGroup.activeTab?.label ?? '', /^app\.ts \(added in [0-9a-f]{7}\)$/);
    const modified = await vscode.workspace.openTextDocument(input.modified);
    assert.ok(modified.getText().includes('typedByHand'), 'the right side is not the committed file');
    await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
  });
});
