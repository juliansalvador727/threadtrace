// Installs tt-capture.js and merges the hook config into a Claude Code settings
// file. It always shows the exact diff and asks for confirmation before writing.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { formatSettings, hasHooks, mergeHooks, parseSettings, removeHooks } from './hookConfig';

const DIFF_SCHEME = 'thread-trace-settings';

interface Target {
  label: string;
  description: string;
  file: string;
}

/** Serves the before/after settings text to the diff editor. */
class SettingsPreview implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  uri(side: 'current' | 'proposed', file: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: DIFF_SCHEME, path: `/${side}/${path.basename(file)}`, query: file });
    this.contents.set(uri.toString(), text);
    return uri;
  }
}

function installedScriptPath(): string {
  return path.join(os.homedir(), '.thread-trace', 'bin', 'tt-capture.js');
}

async function pickTarget(action: string): Promise<Target | undefined> {
  const targets: Target[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    targets.push({
      label: 'This project',
      description: '.claude/settings.local.json (stays on this machine, not committed)',
      file: path.join(folder.uri.fsPath, '.claude', 'settings.local.json'),
    });
  }
  targets.push({
    label: 'All projects',
    description: '~/.claude/settings.json',
    file: path.join(os.homedir(), '.claude', 'settings.json'),
  });
  return vscode.window.showQuickPick(targets, { title: `Thread Trace: ${action} agent hooks`, placeHolder: 'Where?' });
}

function readIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Shows the diff and asks. Returns true only on an explicit confirmation. */
async function confirm(
  preview: SettingsPreview,
  file: string,
  current: string,
  proposed: string,
  action: string,
): Promise<boolean> {
  await vscode.commands.executeCommand(
    'vscode.diff',
    preview.uri('current', file, current),
    preview.uri('proposed', file, proposed),
    `Thread Trace: ${path.basename(file)} (current ↔ proposed)`,
    { preview: true },
  );
  const choice = await vscode.window.showWarningMessage(
    `${action} Thread Trace hooks in ${file}?`,
    { modal: true, detail: 'The diff editor shows exactly what will be written.' },
    action,
  );
  return choice === action;
}

async function change(context: vscode.ExtensionContext, preview: SettingsPreview, install: boolean): Promise<void> {
  const action = install ? 'Install' : 'Uninstall';
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showWarningMessage('Thread Trace: hook changes are disabled in untrusted workspaces.');
    return;
  }
  const target = await pickTarget(action);
  if (!target) return;

  const currentText = readIfExists(target.file);
  let settings: Record<string, unknown>;
  try {
    settings = parseSettings(currentText);
  } catch (error) {
    void vscode.window.showErrorMessage(
      `Thread Trace: ${target.file} is not valid JSON, so it was left unchanged. (${(error as Error).message})`,
    );
    return;
  }
  if (!install && !hasHooks(settings)) {
    void vscode.window.showInformationMessage(`Thread Trace: no hooks found in ${target.file}.`);
    return;
  }

  const script = installedScriptPath();
  const proposedText = formatSettings(install ? mergeHooks(settings, script) : removeHooks(settings));
  if (!(await confirm(preview, target.file, currentText ?? '', proposedText, action))) return;

  if (install) {
    fs.mkdirSync(path.dirname(script), { recursive: true });
    fs.copyFileSync(path.join(context.extensionPath, 'dist', 'tt-capture.js'), script);
  }
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, proposedText);
  void vscode.window.showInformationMessage(
    install
      ? `Thread Trace: hooks installed in ${target.file}. New Claude Code sessions will record edits.`
      : `Thread Trace: hooks removed from ${target.file}.`,
  );
}

export function registerHookCommands(context: vscode.ExtensionContext): void {
  const preview = new SettingsPreview();
  const run = (install: boolean) => async () => {
    try {
      await change(context, preview, install);
    } catch (error) {
      void vscode.window.showErrorMessage(`Thread Trace: ${(error as Error).message}`);
    }
  };
  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider(DIFF_SCHEME, preview),
    vscode.commands.registerCommand('threadTrace.installHooks', run(true)),
    vscode.commands.registerCommand('threadTrace.uninstallHooks', run(false)),
  );
}
