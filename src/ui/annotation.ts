// End-of-line annotation on the cursor line, with the hover card attached
// (docs/SPEC.md, "Current-line annotation" and "Hover card").
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitService, RepoServices } from '../git/gitService';
import type { Attribution, Edit, Turn } from '../store/schema';
import { annotationText, renderCard, type Card, type CardFilter } from './hoverCard';
import type { Revealed, ThreadPanels } from './threadPanel';

const DEBOUNCE_MS = 150;
/** Blame gets the whole buffer on stdin; skip files where that would be slow. */
const MAX_DOCUMENT_CHARS = 5_000_000;

export interface LineResult {
  uri: vscode.Uri;
  /** 0-based, as in the editor. */
  line: number;
  repo: RepoServices;
  /** Repo-relative path. */
  file: string;
  attribution: Attribution;
  text: string;
  card: Card;
}

/** What `activate()` returns, for the integration tests. */
export interface ThreadTraceApi {
  resolveLine(uri: vscode.Uri, line: number): Promise<{ text: string; markdown: string; confidence: string } | undefined>;
  /** Opens the thread panel for a line and waits for the webview to report what it scrolled to. */
  openThread(uri: vscode.Uri, line: number): Promise<{ title: string; html: string; revealed: Revealed } | undefined>;
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration('threadTrace').get<boolean>('annotation.enabled', true);
}

export class LineAnnotation implements vscode.Disposable {
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    after: { margin: '0 0 0 3em', color: new vscode.ThemeColor('editorCodeLens.foreground') },
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedOpen,
  });
  private readonly disposables: vscode.Disposable[] = [this.decoration];
  private timer: NodeJS.Timeout | undefined;
  /** Bumped on every update, so a slow resolve for an old cursor position is dropped. */
  private generation = 0;
  private filter: CardFilter = 'all';
  private shown: LineResult | undefined;

  constructor(private readonly git: GitService) {
    this.disposables.push(
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor === vscode.window.activeTextEditor) this.schedule();
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document === vscode.window.activeTextEditor?.document) this.schedule();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('threadTrace.annotation')) this.schedule();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule()),
      git.onDidChangeRecords(() => this.schedule()),
    );
    this.schedule();
  }

  /** The attribution currently on screen, if any. */
  get current(): LineResult | undefined {
    return this.shown;
  }

  setFilter(filter: CardFilter): void {
    this.filter = filter;
    const editor = vscode.window.activeTextEditor;
    if (!this.shown || !editor || editor.document.uri.toString() !== this.shown.uri.toString()) return;
    this.shown = { ...this.shown, card: this.card(this.shown.attribution, this.shown.file) };
    this.render(editor, this.shown);
  }

  /** Resolves one line without touching the editor. Undefined when the line can't be attributed at all. */
  async resolveLine(document: vscode.TextDocument, line: number): Promise<LineResult | undefined> {
    // Blame runs git inside the repo, and a repo's git config can run
    // commands, so nothing is resolved until the workspace is trusted.
    if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file') return undefined;
    if (line < 0 || line >= document.lineCount) return undefined;
    const text = document.getText();
    if (text.length > MAX_DOCUMENT_CHARS) return undefined;
    const found = await this.git.forFile(document.uri.fsPath);
    if (!found) return undefined;
    const attribution = await found.repo.resolver.resolve({
      file: found.file,
      line: line + 1,
      text,
      version: `${document.uri.toString()}@${document.version}`,
    });
    return this.result(document.uri, line, found.repo, found.file, attribution);
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.generation++;
    for (const disposable of this.disposables) disposable.dispose();
  }

  private result(uri: vscode.Uri, line: number, repo: RepoServices, file: string, attribution: Attribution): LineResult {
    return {
      uri,
      line,
      repo,
      file,
      attribution,
      text: annotationText(attribution, Date.now()),
      card: this.card(attribution, file),
    };
  }

  private card(attribution: Attribution, file: string): Card {
    return renderCard(attribution, { now: Date.now(), filter: this.filter, file });
  }

  private schedule(): void {
    const editor = vscode.window.activeTextEditor;
    // Don't leave the old text hanging on a line the cursor has left.
    if (this.shown && (!editor || editor.selection.active.line !== this.shown.line || editor.document.uri.toString() !== this.shown.uri.toString())) {
      this.clear();
    }
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), DEBOUNCE_MS);
  }

  private clear(): void {
    this.shown = undefined;
    for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.decoration, []);
  }

  private async update(): Promise<void> {
    const generation = ++this.generation;
    const editor = vscode.window.activeTextEditor;
    if (!editor || !enabled()) {
      this.clear();
      return;
    }
    const { document } = editor;
    const line = editor.selection.active.line;
    const version = document.version;
    const stale = () =>
      generation !== this.generation ||
      vscode.window.activeTextEditor !== editor ||
      editor.selection.active.line !== line ||
      document.version !== version;
    try {
      const result = await this.resolveLine(document, line);
      if (stale()) return;
      if (!result) {
        this.clear();
        return;
      }
      this.shown = result;
      this.render(editor, result);

      // The line's older commits need `git log -L`, which is slow, so they
      // are added to the card after the annotation is already on screen.
      const expanded = await result.repo.resolver.withCommitChain(result.attribution);
      if (stale() || expanded === result.attribution) return;
      this.shown = this.result(result.uri, line, result.repo, result.file, expanded);
      this.render(editor, this.shown);
    } catch (error) {
      if (stale()) return;
      this.clear();
      console.warn('Thread Trace: could not resolve line', error);
    }
  }

  private render(editor: vscode.TextEditor, result: LineResult): void {
    const hover = new vscode.MarkdownString(result.card.markdown, true);
    hover.supportHtml = true;
    // Only the listed commands can run from a link in the card.
    hover.isTrusted = { enabledCommands: result.card.enabledCommands };
    const end = editor.document.lineAt(result.line).range.end;
    editor.setDecorations(this.decoration, [
      { range: new vscode.Range(end, end), hoverMessage: hover, renderOptions: { after: { contentText: result.text } } },
    ]);
  }
}

/** The line's edits with their turns: the current one, then the older ones. */
function threadsOf(attribution: Attribution): { edit: Edit; turn?: Turn }[] {
  const threads = attribution.edit ? [{ edit: attribution.edit, turn: attribution.turn }] : [];
  for (const entry of attribution.history) if (entry.edit) threads.push({ edit: entry.edit, turn: entry.turn });
  return threads;
}

function turnsOf(attribution: Attribution): Turn[] {
  const turns = attribution.turn ? [attribution.turn] : [];
  for (const entry of attribution.history) if (entry.turn) turns.push(entry.turn);
  return turns;
}

const SHA = /^[0-9a-f]{7,64}$/;

/** Creates the annotation and registers its commands. */
export function registerAnnotation(context: vscode.ExtensionContext, git: GitService, panels: ThreadPanels): ThreadTraceApi {
  const annotation = new LineAnnotation(git);

  /** The attribution for a command: the one on screen, or the cursor line resolved now. */
  const forCommand = async (): Promise<LineResult | undefined> => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return annotation.current;
    const line = editor.selection.active.line;
    const shown = annotation.current;
    if (shown && shown.line === line && shown.uri.toString() === editor.document.uri.toString()) return shown;
    return annotation.resolveLine(editor.document, line);
  };

  /** The turn a hover link names, or the cursor line's own turn when run from the palette. */
  const findTurn = async (turnId: unknown): Promise<Turn | undefined> => {
    const result = await forCommand();
    if (!result) return undefined;
    if (typeof turnId !== 'string') return result.attribution.turn;
    return turnsOf(result.attribution).find((turn) => turn.id === turnId);
  };

  const command = (id: string, run: (...args: unknown[]) => Promise<void> | void) =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await run(...args);
      } catch (error) {
        void vscode.window.showErrorMessage(`Thread Trace: ${(error as Error).message}`);
      }
    });

  context.subscriptions.push(
    annotation,
    command('threadTrace.toggleAnnotation', async () => {
      const config = vscode.workspace.getConfiguration('threadTrace');
      const on = config.get<boolean>('annotation.enabled', true);
      await config.update('annotation.enabled', !on, vscode.ConfigurationTarget.Global);
    }),
    command('threadTrace.showThreadForLine', async (editId) => {
      const result = await forCommand();
      const threads = result ? threadsOf(result.attribution) : [];
      // A hover link names the edit; from the palette it is the line's current one.
      const thread = typeof editId === 'string' ? threads.find(({ edit }) => edit.id === editId) : threads[0];
      if (!result || !thread) {
        void vscode.window.showInformationMessage('Thread Trace: no agent thread is recorded for this line.');
        return;
      }
      panels.show({ ...thread, root: result.repo.root });
    }),
    command('threadTrace.copyPrompt', async (turnId) => {
      const turn = await findTurn(turnId);
      if (!turn || turn.prompt === '') {
        void vscode.window.showInformationMessage('Thread Trace: no prompt is recorded for this line.');
        return;
      }
      await vscode.env.clipboard.writeText(turn.prompt);
      vscode.window.setStatusBarMessage('Thread Trace: prompt copied', 2000);
    }),
    command('threadTrace.openOnWeb', async (turnId) => {
      const url = (await findTurn(turnId))?.thread_url;
      if (!url?.startsWith('https://')) {
        void vscode.window.showInformationMessage('Thread Trace: this thread has no web link.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url, true));
    }),
    command('threadTrace.copySha', async (sha) => {
      if (typeof sha !== 'string' || !SHA.test(sha)) return;
      await vscode.env.clipboard.writeText(sha);
      vscode.window.setStatusBarMessage('Thread Trace: commit hash copied', 2000);
    }),
    command('threadTrace.openCommitDiff', async (sha, file) => {
      const root = annotation.current?.repo.root;
      if (typeof sha !== 'string' || !SHA.test(sha) || typeof file !== 'string' || !root) return;
      const target = path.resolve(root, file);
      // The path comes from a link: keep it inside the repo.
      if (path.relative(root, target).startsWith('..')) return;
      const uri = vscode.Uri.file(target);
      const [before, after] = await Promise.all([git.toGitUri(uri, `${sha}~1`), git.toGitUri(uri, sha)]);
      if (!before || !after) throw new Error('the built-in Git extension is not available.');
      await vscode.commands.executeCommand('vscode.diff', before, after, `${path.basename(file)} (${sha.slice(0, 7)})`);
    }),
    command('threadTrace.hoverFilter', (filter) => {
      if (filter === 'all' || filter === 'threads' || filter === 'commits') annotation.setFilter(filter);
    }),
  );

  return {
    async resolveLine(uri, line) {
      const document = await vscode.workspace.openTextDocument(uri);
      const result = await annotation.resolveLine(document, line);
      return result && { text: result.text, markdown: result.card.markdown, confidence: result.attribution.confidence };
    },
    async openThread(uri, line) {
      const document = await vscode.workspace.openTextDocument(uri);
      const result = await annotation.resolveLine(document, line);
      const thread = result && threadsOf(result.attribution)[0];
      const open = thread && panels.show({ ...thread, root: result.repo.root });
      return open && { title: open.panel.title, html: open.panel.webview.html, revealed: await open.revealed };
    },
  };
}
