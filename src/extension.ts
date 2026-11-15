import type * as vscode from 'vscode';
import { registerHookCommands } from './install/hookInstaller';

// M1: only the hook install/uninstall commands. The read side (store, resolver,
// annotation) is registered here from M2 onwards.
export function activate(context: vscode.ExtensionContext): void {
  registerHookCommands(context);
}

export function deactivate(): void {}
