import * as assert from 'node:assert';
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
});
