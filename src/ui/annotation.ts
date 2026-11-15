// End-of-line annotation on the cursor line, with the hover card attached
// (docs/SPEC.md, "Current-line annotation" and "Hover card").
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitService, RepoServices } from '../git/gitService';
import { commitFileChange } from '../git/log';
import type { Attribution, CommitInfo, Edit, Turn } from '../store/schema';
import { annotationText, compactLine, renderCard, type Card, type CardFilter } from './hoverCard';
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

/** A file's summary as the status bar and heatmap show it. */
export interface FileOverview {
  /** The status bar text. */
  text: string;
  percent: number;
  groups: { label: string; lines: number; modified: number; commit: number }[];
  /** Lines the heatmap colors. */
  colored: number;
}

/** What `activate()` returns, for the integration tests. */
export interface ThreadTraceApi {
  /** M5: the whole-file summary behind the status bar item and the heatmap. */
  fileOverview(uri: vscode.Uri): Promise<FileOverview | undefined>;
  /** M5: the rows of the Agent Threads view for a file. */
  fileThreads(uri: vscode.Uri): Promise<{ label: string; description: string; edits: string[] }[]>;
  /** M5: opens the thread panel from the Agent Threads view's first thread. */
  openFirstThread(uri: vscode.Uri): Promise<{ title: string; revealed: Revealed } | undefined>;
  /** M5: the Agent Trace records the export would write, without writing them. */
  agentTrace(): Promise<{ revision: string; records: unknown[]; lines: number } | undefined>;
  resolveLine(uri: vscode.Uri, line: number): Promise<{ text: string; markdown: string; confidence: string } | undefined>;
  /** Opens the thread panel for a line and waits for the webview to report what it scrolled to. */
  openThread(uri: vscode.Uri, line: number): Promise<{ title: string; html: string; revealed: Revealed } | undefined>;
}

function enabled(): boolean {
  return vscode.workspace.getConfiguration('threadTrace').get<boolean>('annotation.enabled', true);
}

function hoverAnywhere(): boolean {
  return vscode.workspace.getConfiguration('threadTrace').get<string>('hover.mode', 'annotation') === 'anywhere';
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
  /** The line last resolved for an ordinary hover (`hover.mode: "anywhere"`), whose links may name its edits. */
  private hovered: LineResult | undefined;
  private hoverProvider: vscode.Disposable | undefined;

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
        if (event.affectsConfiguration('threadTrace.hover')) this.registerHover();
        // `blame.detectMoves` changes what a line resolves to.
        if (event.affectsConfiguration('threadTrace.annotation') || event.affectsConfiguration('threadTrace.blame')) this.schedule();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule()),
      git.onDidChangeRecords(() => this.schedule()),
    );
    this.registerHover();
    this.schedule();
  }

  /** The attribution currently on screen, if any. */
  get current(): LineResult | undefined {
    return this.shown;
  }

  /** The attributions a hover link can refer to: the annotation's line, then the last hovered one. */
  get linkable(): LineResult[] {
    return [this.shown, this.hovered].filter((result) => result !== undefined);
  }

  /**
   * `threadTrace.hover.mode: "anywhere"`: one attribution line added to the
   * editor's normal hover, on any line. Off by default because it is noisier.
   */
  private registerHover(): void {
    this.hoverProvider?.dispose();
    this.hoverProvider = undefined;
    this.hovered = undefined;
    if (!hoverAnywhere()) return;
    this.hoverProvider = vscode.languages.registerHoverProvider(
      { scheme: 'file' },
      {
        provideHover: async (document, position) => {
          try {
            const result = await this.resolveLine(document, position.line);
            if (!result) return undefined;
            this.hovered = result;
            const line = compactLine(result.attribution, Date.now());
            const markdown = new vscode.MarkdownString(line.markdown, true);
            markdown.isTrusted = { enabledCommands: line.enabledCommands };
            return new vscode.Hover(markdown);
          } catch {
            // A failed blame must not break the editor's other hovers.
            return undefined;
          }
        },
      },
    );
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
    this.hoverProvider?.dispose();
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

/** The line's commits: the one it landed in, then the older ones. */
function commitsOf(attribution: Attribution): CommitInfo[] {
  const commits = attribution.commit ? [attribution.commit] : [];
  for (const entry of attribution.history) if (entry.commit) commits.push(entry.commit);
  return commits;
}

const SHA = /^[0-9a-f]{7,64}$/;
/** Serves an empty document: the left side of the diff for a file a commit added. */
const EMPTY_SCHEME = 'thread-trace-empty';
/** Trailers are untrusted; trailers.ts keeps only claude.ai links, and this checks again before opening one. */
const SESSION_URL = /^https:\/\/claude\.ai\//;

/** Creates the annotation and registers its commands. */
export function registerAnnotation(
  context: vscode.ExtensionContext,
  git: GitService,
  panels: ThreadPanels,
): Pick<ThreadTraceApi, 'resolveLine' | 'openThread'> {
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
    vscode.workspace.registerTextDocumentContentProvider(EMPTY_SCHEME, { provideTextDocumentContent: () => '' }),
    annotation,
    command('threadTrace.toggleAnnotation', async () => {
      const config = vscode.workspace.getConfiguration('threadTrace');
      const on = config.get<boolean>('annotation.enabled', true);
      await config.update('annotation.enabled', !on, vscode.ConfigurationTarget.Global);
    }),
    command('threadTrace.showThreadForLine', async (editId) => {
      let result = await forCommand();
      let threads = result ? threadsOf(result.attribution) : [];
      // A hover link names the edit; from the palette it is the line's current one.
      let thread = typeof editId === 'string' ? threads.find(({ edit }) => edit.id === editId) : threads[0];
      if (!thread && typeof editId === 'string') {
        // The link may be in the hover of a line the cursor isn't on.
        for (const other of annotation.linkable) {
          threads = threadsOf(other.attribution);
          thread = threads.find(({ edit }) => edit.id === editId);
          if (thread) {
            result = other;
            break;
          }
        }
      }
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
    command('threadTrace.openCommitSession', async (sha) => {
      if (typeof sha !== 'string' || !SHA.test(sha)) return;
      // The link names a commit; the URL is the one read from that commit's message.
      const results = [await forCommand(), ...annotation.linkable].filter((result) => result !== undefined);
      const commit = results.flatMap((result) => commitsOf(result.attribution)).find((entry) => entry.sha === sha);
      const url = commit?.trailers.session;
      if (!url || !SESSION_URL.test(url)) {
        void vscode.window.showInformationMessage('Thread Trace: this commit has no session link.');
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url, true));
    }),
    command('threadTrace.openOnWeb', async (turnId) => {
      let url = (await findTurn(turnId))?.thread_url;
      if (!url && turnId === undefined) {
        // From the palette: a line known only from its commit's trailer has no turn.
        const session = (await forCommand())?.attribution.commit?.trailers.session;
        if (session && SESSION_URL.test(session)) url = session;
      }
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
      const repo = annotation.current?.repo;
      if (typeof sha !== 'string' || !SHA.test(sha) || typeof file !== 'string' || !repo) return;
      const root = repo.root;
      const target = path.resolve(root, file);
      // The path comes from a link: keep it inside the repo.
      if (path.relative(root, target).startsWith('..')) return;
      const change = await commitFileChange(repo.git, sha, path.relative(root, target).split(path.sep).join('/'));
      if (!change) {
        void vscode.window.showInformationMessage(`Thread Trace: ${path.basename(file)} is not in commit ${sha.slice(0, 7)}.`);
        return;
      }
      const at = (rel: string) => vscode.Uri.file(path.join(root, rel));
      const [before, after] = await Promise.all([
        // A file the commit added has an empty left side, as in git's own diff.
        change.before ? git.toGitUri(at(change.before), `${sha}^1`) : vscode.Uri.from({ scheme: EMPTY_SCHEME, path: `/${path.basename(change.after)}` }),
        git.toGitUri(at(change.after), sha),
      ]);
      if (!before || !after) throw new Error('the built-in Git extension is not available.');
      const name = change.before && change.before !== change.after
        ? `${path.basename(change.before)} → ${path.basename(change.after)}`
        : path.basename(change.after);
      const what = change.before ? sha.slice(0, 7) : `added in ${sha.slice(0, 7)}`;
      await vscode.commands.executeCommand('vscode.diff', before, after, `${name} (${what})`);
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
