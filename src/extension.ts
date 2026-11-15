import * as path from 'node:path';
import * as vscode from 'vscode';
import { AGENT_TRACE_FILE, collectAgentTrace, writeAgentTrace } from './adapters/agentTrace';
import { backfill } from './backfill/backfill';
import { traceHome } from './capture/capture';
import { findRepo } from './capture/gitDir';
import { GitService } from './git/gitService';
import { syncCaptureConfig } from './install/captureConfig';
import { registerHookCommands } from './install/hookInstaller';
import { registerAnnotation, type ThreadTraceApi } from './ui/annotation';
import { statusText } from './ui/fileSummary';
import { Heatmap } from './ui/heatmap';
import { StatusSummary } from './ui/statusBar';
import { ThreadPanels } from './ui/threadPanel';
import { ThreadsView } from './ui/threadsView';

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
  const start = startDir();
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

/** The folder to look for a repo from: the active file's, else the first workspace folder. */
function startDir(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  return active?.scheme === 'file' ? path.dirname(active.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

/**
 * Thread Trace: Export Agent Trace. Shows the records, asks, then writes
 * `.agent-trace/traces.jsonl` in the repo. Nothing is written without the confirmation.
 */
async function runExport(git: GitService): Promise<void> {
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Thread Trace: export is disabled in untrusted workspaces.');
    return;
  }
  const start = startDir();
  const repo = start ? await git.forDir(start) : undefined;
  if (!repo) {
    void vscode.window.showInformationMessage('Thread Trace: open a file in a git repository to export its attribution.');
    return;
  }
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Thread Trace: resolving agent lines at HEAD', cancellable: true },
    (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      return collectAgentTrace(repo.git, repo.store, repo.resolver, {
        signal: abort.signal,
        onProgress: (done, total) => progress.report({ message: `${done} of ${plural(total, 'file')}` }),
      });
    },
  );
  if (!result) {
    void vscode.window.showInformationMessage('Thread Trace: this repository has no commit to export attribution for.');
    return;
  }
  if (result.cancelled) return;
  const { totals, revision } = result;
  if (totals.records === 0) {
    void vscode.window.showInformationMessage(`Thread Trace: no agent-written lines were found at ${revision.slice(0, 7)}; nothing to export.`);
    return;
  }
  // The preview is what will be written, one record per line in the file, indented here to be readable.
  const preview = await vscode.workspace.openTextDocument({ language: 'json', content: JSON.stringify(result.records, null, 2) });
  await vscode.window.showTextDocument(preview, { preview: true });
  const skipped = result.skipped > 0 ? ` ${plural(result.skipped, 'file')} with records ${result.skipped === 1 ? 'is' : 'are'} not at HEAD under that name and ${result.skipped === 1 ? 'was' : 'were'} left out.` : '';
  const answer = await vscode.window.showInformationMessage(
    `Write ${plural(totals.records, 'record')} to ${AGENT_TRACE_FILE}?`,
    {
      modal: true,
      detail:
        `${plural(totals.lines, 'line')} in ${plural(totals.files, 'file')}, as committed at ${revision.slice(0, 7)}.${skipped} ` +
        'The records hold paths, line ranges, model names, session ids and session links. Prompts are not included. ' +
        'The file is in the working tree, so it is shared once you commit it.',
    },
    'Write',
  );
  if (answer !== 'Write') return;
  const file = writeAgentTrace(repo.root, result.records, revision);
  const open = await vscode.window.showInformationMessage(`Thread Trace: wrote ${plural(totals.records, 'record')} to ${AGENT_TRACE_FILE}.`, 'Open');
  if (open === 'Open') await vscode.window.showTextDocument(vscode.Uri.file(file));
}

/**
 * Copies `threadTrace.capture.*` to `~/.thread-trace/config.json`, where the
 * hook reads it. Only values set in the user settings count: the settings are
 * application-scoped, so a workspace can't change what is captured.
 */
function syncCapture(removeUnset: boolean): void {
  const config = vscode.workspace.getConfiguration('threadTrace');
  try {
    const { invalid } = syncCaptureConfig(
      traceHome(process.env),
      { prompt: config.inspect('capture.prompt')?.globalValue, redact: config.inspect('capture.redact')?.globalValue },
      removeUnset,
    );
    if (invalid.length > 0) {
      void vscode.window.showWarningMessage(
        `Thread Trace: ${plural(invalid.length, 'redaction pattern')} in threadTrace.capture.redact ${invalid.length === 1 ? "isn't a valid regular expression and is" : "aren't valid regular expressions and are"} ignored.`,
      );
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Thread Trace: could not write the capture settings: ${(error as Error).message}`);
  }
}

// M1: the hook install/uninstall commands. M2: the read side, which is the
// store, the resolver and the cursor-line annotation with its hover card.
// M3: the thread panel. M4: backfill. M5: the heatmap, the status bar summary,
// the Agent Threads view, the Agent Trace export and the capture settings.
// Records are loaded on the first resolve, not here.
export function activate(context: vscode.ExtensionContext): ThreadTraceApi {
  registerHookCommands(context);
  const git = new GitService();
  const panels = new ThreadPanels(context);
  const heatmap = new Heatmap(git);
  const status = new StatusSummary(heatmap);
  const threads = new ThreadsView(git, panels);
  const command = (id: string, run: () => Promise<void>) =>
    vscode.commands.registerCommand(id, async () => {
      try {
        await run();
      } catch (error) {
        void vscode.window.showErrorMessage(`Thread Trace: ${(error as Error).message}`);
      }
    });
  context.subscriptions.push(
    git,
    panels,
    heatmap,
    status,
    threads,
    command('threadTrace.backfill', runBackfill),
    command('threadTrace.exportAgentTrace', () => runExport(git)),
    command('threadTrace.showLegend', () => status.showLegend()),
    command('threadTrace.toggleHeatmap', async () => {
      const config = vscode.workspace.getConfiguration('threadTrace');
      await config.update('heatmap.enabled', !config.get<boolean>('heatmap.enabled', false), vscode.ConfigurationTarget.Global);
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      // A change is the user's decision, so a setting put back to its default is removed from the file too.
      if (event.affectsConfiguration('threadTrace.capture')) syncCapture(true);
    }),
  );
  syncCapture(false);

  return {
    ...registerAnnotation(context, git, panels),
    async fileOverview(uri) {
      const scan = await heatmap.scan(await vscode.workspace.openTextDocument(uri));
      return scan && { text: statusText(scan.summary), percent: scan.summary.percent, groups: scan.summary.groups, colored: heatmap.coloredLines(scan) };
    },
    async fileThreads(uri) {
      const found = await threads.threadsFor(await vscode.workspace.openTextDocument(uri));
      return (found?.threads ?? []).map((thread) => ({ label: thread.label, description: thread.description, edits: thread.edits.map((row) => row.label) }));
    },
    async openFirstThread(uri) {
      const found = await threads.threadsFor(await vscode.workspace.openTextDocument(uri));
      const thread = found?.threads[0];
      const open = thread && panels.show({ edit: thread.newest, turn: thread.turn, root: found.repo.root });
      return open && { title: open.panel.title, revealed: await open.revealed };
    },
    async agentTrace() {
      const start = startDir();
      const repo = start ? await git.forDir(start) : undefined;
      const result = repo && (await collectAgentTrace(repo.git, repo.store, repo.resolver));
      return result && { revision: result.revision, records: result.records, lines: result.totals.lines };
    },
  };
}

export function deactivate(): void {}
