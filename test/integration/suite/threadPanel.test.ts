import * as assert from 'node:assert';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ThreadTraceApi } from '../../../src/ui/annotation';

// Acceptance test 6, against the repo and transcript that runTest.ts seeds.
describe('thread panel', () => {
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

  after(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  it('offers Open thread in the hover card', async () => {
    const result = await api.resolveLine(file, 2);
    assert.ok(result?.markdown.includes('command:threadTrace.showThreadForLine'), result?.markdown);
  });

  it('opens the transcript scrolled to the tool call that wrote the line', async () => {
    const opened = await api.openThread(file, 2);
    assert.ok(opened, 'the panel did not open');
    assert.strictEqual(opened.title, 'Add a total helper');
    // The webview's own script reports what it found, scrolled to and highlighted.
    assert.deepStrictEqual(opened.revealed, { id: 'toolu_integration_edit', found: true });
    assert.ok(opened.html.includes('<article class="edit target" data-tool="toolu_integration_edit">'), 'the edit is not marked as the target');
    assert.ok(opened.html.includes('+  return price * quantity;'), 'the diff is missing');
    assert.ok(opened.html.includes('<summary>Read 1 file</summary>'), 'the tool summary is missing');
  });

  it('renders markup in the transcript as text', async () => {
    const opened = await api.openThread(file, 2);
    assert.ok(opened);
    assert.ok(opened.html.includes('&lt;script&gt;document.title'));
    assert.strictEqual(opened.html.match(/<script/g)?.length, 1);
    assert.strictEqual(opened.title, 'Add a total helper');
  });

  it('opens from the command for the cursor line, reusing the panel', async () => {
    const editor = await vscode.window.showTextDocument(file, { viewColumn: vscode.ViewColumn.One });
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('threadTrace.showThreadForLine');
    const panels = vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.input instanceof vscode.TabInputWebview);
    assert.strictEqual(panels.length, 1);
    assert.strictEqual(panels[0].label, 'Add a total helper');
  });
});
