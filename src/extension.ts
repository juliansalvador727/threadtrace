import * as path from 'node:path';
import * as vscode from 'vscode';
import { backfill } from './backfill/backfill';
import { findRepo } from './capture/gitDir';
import { GitService } from './git/gitService';
import { registerHookCommands } from './install/hookInstaller';
import { registerAnnotation, type ThreadTraceApi } from './ui/annotation';
import { ThreadPanels } from './ui/threadPanel';

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** Thread Trace: Backfill from Transcripts. Imports edits from the transcripts of the active file's repo. */
async function runBackfill(): Promise<void> {
  // Transcripts are untrusted content, and the records feed the read side.
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Thread Trace: backfill is disabled in untrusted workspaces.');
    return;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  const start = active?.scheme === 'file' ? path.dirname(active.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const repo = start ? findRepo(start) : undefined;
  if (!repo) {
    void vscode.window.showInformationMessage('Thread Trace: open a file in a git repository to backfill it.');
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Thread Trace: reading transcripts', cancellable: true },
    (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      let reported = 0;
      return backfill(repo, {
        env: process.env,
        signal: abort.signal,
        onProgress: (done, total) => {
          progress.report({ message: `${done} of ${total}`, increment: ((done - reported) / total) * 100 });
          reported = done;
        },
      });
    },
  );
  const found =
    result.edits > 0
      ? `imported ${plural(result.edits, 'edit')} from ${plural(result.sessions, 'session')}`
      : result.transcripts === 0
        ? 'no transcripts were found for this repository'
        : 'nothing new to import';
  const already = result.existing > 0 ? `; ${result.existing} already recorded` : '';
  void vscode.window.showInformationMessage(`Thread Trace: ${found}${already}${result.cancelled ? ' (cancelled)' : ''}.`);
}

// M1: the hook install/uninstall commands. M2: the read side, which is the
// store, the resolver and the cursor-line annotation with its hover card.
// M3: the thread panel. M4: backfill. Records are loaded on the first resolve, not here.
export function activate(context: vscode.ExtensionContext): ThreadTraceApi {
  registerHookCommands(context);
  const git = new GitService();
  const panels = new ThreadPanels(context);
  context.subscriptions.push(
    git,
    panels,
    vscode.commands.registerCommand('threadTrace.backfill', async () => {
      try {
        await runBackfill();
      } catch (error) {
        void vscode.window.showErrorMessage(`Thread Trace: ${(error as Error).message}`);
      }
    }),
  );
  return registerAnnotation(context, git, panels);
}

export function deactivate(): void {}
