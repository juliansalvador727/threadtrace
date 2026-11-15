import * as assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ThreadTraceApi } from '../../../src/ui/annotation';

// M5 surfaces, against the repo that runTest.ts seeds: app.ts has three
// agent lines out of five, cloud.ts is known only from its commit's trailers.
describe('M5: heatmap, status bar, threads view, export, settings', () => {
  let api: ThreadTraceApi;
  let workspace: string;
  let app: vscode.Uri;

  before(async () => {
    workspace = process.env.THREAD_TRACE_TEST_WORKSPACE ?? '';
    assert.ok(workspace, 'THREAD_TRACE_TEST_WORKSPACE is not set');
    app = vscode.Uri.file(path.join(workspace, 'app.ts'));
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'thread-trace');
    assert.ok(extension, 'thread-trace extension not found');
    api = (await extension.activate()) as ThreadTraceApi;
  });

  after(() => vscode.commands.executeCommand('workbench.action.closeAllEditors'));

  it('registers the M5 commands and the Agent Threads view', async () => {
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['threadTrace.toggleHeatmap', 'threadTrace.showLegend', 'threadTrace.exportAgentTrace', 'threadTrace.openThreadFromView', 'threadTrace.threads.focus']) {
      assert.ok(commands.includes(id), `${id} is not registered`);
    }
  });

  it('summarizes a file for the status bar and the heatmap', async () => {
    const overview = await api.fileOverview(app);
    assert.deepStrictEqual(overview, {
      text: '✦ 60% agent',
      percent: 60,
      groups: [{ label: 'Claude Opus 5.5', lines: 3, modified: 0, commit: 0 }],
      colored: 3,
    });
    const cloud = await api.fileOverview(vscode.Uri.file(path.join(workspace, 'cloud.ts')));
    assert.strictEqual(cloud?.text, '✦ 100% agent');
    assert.deepStrictEqual(cloud.groups, [{ label: 'Claude Opus 5.5', lines: 3, modified: 0, commit: 3 }]);
  });

  it('toggles the heatmap setting and keeps working with it on', async () => {
    const enabled = () => vscode.workspace.getConfiguration('threadTrace').get<boolean>('heatmap.enabled');
    assert.strictEqual(enabled(), false);
    await vscode.window.showTextDocument(app);
    await vscode.commands.executeCommand('threadTrace.toggleHeatmap');
    try {
      assert.strictEqual(enabled(), true);
      // Give the debounced repaint time to run; a failure there would surface as an unhandled error.
      await new Promise((resolve) => setTimeout(resolve, 600));
      assert.strictEqual((await api.fileOverview(app))?.colored, 3);
    } finally {
      await vscode.commands.executeCommand('threadTrace.toggleHeatmap');
    }
    assert.strictEqual(enabled(), false);
  });

  it('lists the threads that edited a file and opens one from the view', async () => {
    const threads = await api.fileThreads(app);
    assert.strictEqual(threads.length, 1);
    assert.strictEqual(threads[0].label, 'Add a total helper');
    assert.match(threads[0].description, /^1 edit · Claude Opus 5\.5 · /);
    assert.deepStrictEqual(threads[0].edits, ['Edit · lines 2–4']);
    assert.deepStrictEqual(await api.fileThreads(vscode.Uri.file(path.join(workspace, 'cloud.ts'))), []);

    const opened = await api.openFirstThread(app);
    assert.strictEqual(opened?.title, 'Add a total helper');
    assert.deepStrictEqual(opened.revealed, { id: 'toolu_integration_edit', found: true });
  });

  it('builds Agent Trace records for HEAD without writing them', async () => {
    await vscode.window.showTextDocument(app);
    const trace = await api.agentTrace();
    assert.ok(trace, 'nothing was built');
    assert.match(trace.revision, /^[0-9a-f]{40}$/);
    const records = trace.records as { vcs: { revision: string }; files: { path: string; conversations: unknown[] }[]; metadata: Record<string, { session_id?: string }> }[];
    const record = records.find((entry) => Object.values(entry.metadata)[0]?.session_id === 'integration-session');
    assert.ok(record, JSON.stringify(records));
    assert.strictEqual(record.vcs.revision, trace.revision);
    assert.deepStrictEqual(record.files, [
      { path: 'app.ts', conversations: [{ contributor: { type: 'ai', model_id: 'anthropic/claude-opus-5-5' }, ranges: [{ start_line: 2, end_line: 4 }] }] },
    ]);
    assert.ok(!JSON.stringify(records).includes('Add a total helper'), 'a prompt is in the export');
    assert.ok(!existsSync(path.join(workspace, '.agent-trace')), 'the export wrote without being confirmed');
  });

  it('writes the capture settings where the hook reads them', async () => {
    const home = process.env.THREAD_TRACE_HOME;
    assert.ok(home, 'THREAD_TRACE_HOME is not set');
    const file = path.join(home, 'config.json');
    const read = async (expected: (config: Record<string, unknown>) => boolean) => {
      for (let i = 0; i < 40; i++) {
        if (existsSync(file)) {
          const config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
          if (expected(config)) return config;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : undefined;
    };
    const config = vscode.workspace.getConfiguration('threadTrace');
    assert.ok(!existsSync(file), 'a config file was written before any setting was set');
    await config.update('capture.prompt', 'firstLine', vscode.ConfigurationTarget.Global);
    await config.update('capture.redact', ['ACME-\\d+'], vscode.ConfigurationTarget.Global);
    try {
      assert.deepStrictEqual(await read((value) => Array.isArray(value.redact)), { prompt: 'firstLine', redact: ['ACME-\\d+'] });
    } finally {
      await config.update('capture.prompt', undefined, vscode.ConfigurationTarget.Global);
      await config.update('capture.redact', undefined, vscode.ConfigurationTarget.Global);
    }
    assert.deepStrictEqual(await read((value) => Object.keys(value).length === 0), {});
  });
});
