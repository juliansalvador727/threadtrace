import type * as vscode from 'vscode';
import { GitService } from './git/gitService';
import { registerHookCommands } from './install/hookInstaller';
import { registerAnnotation, type ThreadTraceApi } from './ui/annotation';
import { ThreadPanels } from './ui/threadPanel';

// M1: the hook install/uninstall commands. M2: the read side, which is the
// store, the resolver and the cursor-line annotation with its hover card.
// M3: the thread panel. Records are loaded on the first resolve, not here.
export function activate(context: vscode.ExtensionContext): ThreadTraceApi {
  registerHookCommands(context);
  const git = new GitService();
  const panels = new ThreadPanels(context);
  context.subscriptions.push(git, panels);
  return registerAnnotation(context, git, panels);
}

export function deactivate(): void {}
