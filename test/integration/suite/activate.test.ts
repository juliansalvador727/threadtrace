import * as assert from 'node:assert';
import * as vscode from 'vscode';

describe('extension scaffold', () => {
  it('is present and activates without error', async () => {
    const extension = vscode.extensions.all.find((e) => e.packageJSON.name === 'thread-trace');
    assert.ok(extension, 'thread-trace extension not found');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });
});
