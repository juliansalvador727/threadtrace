import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

describe('extension', () => {
  it('is present and activates without error', async () => {
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'thread-trace');
    assert.ok(extension, 'thread-trace extension not found');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  it('registers the hook install and uninstall commands', async () => {
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes('threadTrace.installHooks'));
    assert.ok(commands.includes('threadTrace.uninstallHooks'));
  });

  it('updates a hook script installed by an older version', () => {
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'thread-trace');
    const home = process.env.THREAD_TRACE_HOME;
    assert.ok(extension && home);
    // runTest.ts seeded an old script here before VS Code started.
    const installed = readFileSync(path.join(home, 'bin', 'tt-capture.js'), 'utf8');
    assert.strictEqual(installed, readFileSync(path.join(extension.extensionPath, 'dist', 'tt-capture.js'), 'utf8'));
  });
});
