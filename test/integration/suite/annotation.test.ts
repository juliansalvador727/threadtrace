import * as assert from 'node:assert';
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
    for (const id of ['threadTrace.toggleAnnotation', 'threadTrace.copyPrompt', 'threadTrace.hoverFilter']) {
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

  it('copies the prompt behind the cursor line', async () => {
    const editor = await vscode.window.showTextDocument(file);
    editor.selection = new vscode.Selection(2, 0, 2, 0);
    await vscode.commands.executeCommand('threadTrace.copyPrompt');
    assert.strictEqual(await vscode.env.clipboard.readText(), 'Add a total helper');
  });
});
