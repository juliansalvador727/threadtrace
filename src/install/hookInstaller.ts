// Installs tt-capture.js and merges the hook config into a Claude Code settings
// file. It always shows the exact diff and asks for confirmation before writing.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { traceHome } from '../capture/capture';
import { formatSettings, hasHooks, mergeHooks, parseSettings, removeHooks } from './hookConfig';
import { copyScript, findExecutable, installedScriptPath, refreshInstalledScript } from './hookScript';

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

function bundledScriptPath(context: vscode.ExtensionContext): string {
  return path.join(context.extensionPath, 'dist', 'tt-capture.js');
}

/**
 * The hook command is `node <script>`. Claude Code's native installer doesn't
 * bring Node, so without it every hook run fails and nothing is recorded.
 * Returns true to go on with the install.
 */
async function nodeAvailableOrAccepted(): Promise<boolean> {
  if (findExecutable('node', process.env)) return true;
  const choice = await vscode.window.showWarningMessage(
    'Thread Trace: Node.js was not found on your PATH.',
    {
      modal: true,
      detail:
        'Claude Code runs the hook with `node`. Without Node.js 18 or later on the PATH Claude Code uses, ' +
        'the hook fails and no edits are recorded (your sessions are not affected). ' +
        'If Claude Code sees a different PATH than VS Code, it may still work.',
    },
    'Install Anyway',
  );
  return choice === 'Install Anyway';
}

function targets(): Target[] {
  const list: Target[] = [];
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (folder) {
    list.push({
      label: 'This project',
      description: '.claude/settings.local.json (stays on this machine, not committed)',
      file: path.join(folder.uri.fsPath, '.claude', 'settings.local.json'),
    });
  }
  list.push({
    label: 'All projects',
    description: '~/.claude/settings.json',
    file: path.join(os.homedir(), '.claude', 'settings.json'),
  });
  return list;
}

/** A file that can't be read or parsed stays in the list, so the error is shown once it's picked. */
function mayHaveHooks(target: Target): boolean {
  try {
    return hasHooks(parseSettings(readIfExists(target.file)));
  } catch {
    return true;
  }
}

async function pickTarget(install: boolean): Promise<Target | undefined> {
  const action = install ? 'Install' : 'Uninstall';
  let list = targets();
  if (!install) {
    // Uninstall offers only the files that have the hooks; with one, the confirmation names it.
    list = list.filter(mayHaveHooks);
    if (list.length === 0) {
      void vscode.window.showInformationMessage('Thread Trace: no hooks are installed.');
      return undefined;
    }
    if (list.length === 1) return list[0];
  }
  return vscode.window.showQuickPick(list, { title: `Thread Trace: ${action} agent hooks`, placeHolder: 'Where?' });
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
  const target = await pickTarget(install);
  if (!target) return;
  if (install && !(await nodeAvailableOrAccepted())) return;

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

  const script = installedScriptPath(traceHome(process.env));
  const proposedText = formatSettings(install ? mergeHooks(settings, script) : removeHooks(settings));
  if (!(await confirm(preview, target.file, currentText ?? '', proposedText, action))) return;

  if (install) copyScript(bundledScriptPath(context), script);
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  fs.writeFileSync(target.file, proposedText);
  void vscode.window.showInformationMessage(
    install
      ? `Thread Trace: hooks installed in ${target.file}. New Claude Code sessions will record edits.`
      : `Thread Trace: hooks removed from ${target.file}.`,
  );
}

/**
 * Replaces an installed hook script that differs from this version's, so an
 * extension update reaches the hook. Never creates one and never touches the
 * settings files. Failures are logged, not shown: the old script still works.
 */
export function refreshHookScript(context: vscode.ExtensionContext): void {
  try {
    refreshInstalledScript(bundledScriptPath(context), installedScriptPath(traceHome(process.env)));
  } catch (error) {
    console.error(`Thread Trace: could not update the hook script: ${(error as Error).message}`);
  }
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
