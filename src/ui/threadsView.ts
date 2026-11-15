// Agent Threads view in the Explorer: the threads that edited the active
// file, with their edits (docs/SPEC.md, "Other surfaces").
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GitService, RepoServices } from '../git/gitService';
import type { Edit } from '../store/schema';
import { fileThreads, type FileThread, type ThreadEditRow } from './fileSummary';
import type { ThreadPanels } from './threadPanel';

type Node = { kind: 'thread'; thread: FileThread } | { kind: 'edit'; thread: FileThread; row: ThreadEditRow };

export const OPEN_FROM_VIEW = 'threadTrace.openThreadFromView';

export class ThreadsView implements vscode.TreeDataProvider<Node>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly view: vscode.TreeView<Node>;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  /** The last file editor that had focus. The thread panel taking focus must not empty the view. */
  private document: vscode.TextDocument | undefined;
  private repo: RepoServices | undefined;
  private threads: FileThread[] = [];

  constructor(
    private readonly git: GitService,
    private readonly panels: ThreadPanels,
  ) {
    this.view = vscode.window.createTreeView('threadTrace.threads', { treeDataProvider: this });
    this.document = vscode.window.activeTextEditor?.document;
    this.disposables.push(
      this.view,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (!editor || editor.document === this.document) return;
        this.document = editor.document;
        this.changed.fire();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (document !== this.document) return;
        this.document = undefined;
        this.changed.fire();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.changed.fire()),
      git.onDidChangeRecords(() => this.changed.fire()),
      // The id comes from a tree item this view built, and is looked up among the edits it is showing.
      vscode.commands.registerCommand(OPEN_FROM_VIEW, (editId: unknown) => {
        if (typeof editId === 'string') this.open(editId);
      }),
    );
  }

  /** The threads of a file, newest first. Empty when the file can't be attributed. */
  async threadsFor(document: vscode.TextDocument): Promise<{ repo: RepoServices; threads: FileThread[] } | undefined> {
    // Listing a renamed file's records runs git, which stays off until the workspace is trusted.
    if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file') return undefined;
    const found = await this.git.forFile(document.uri.fsPath);
    if (!found) return undefined;
    const { store, resolver } = found.repo;
    store.refresh();
    let edits: Edit[] = store.editsFor(found.file);
    // Records may be under a name the file had before; only ask git when there are records at all.
    if (store.editCount > 0) {
      const paths = await resolver.pathsOf(found.file);
      edits = paths.flatMap((file) => store.editsFor(file));
    }
    return { repo: found.repo, threads: fileThreads(edits, (id) => store.turn(id), Date.now()) };
  }

  /** Opens the thread panel at one of the edits the view is showing. */
  open(editId: string): ReturnType<ThreadPanels['show']> {
    for (const thread of this.threads) {
      const row = thread.edits.find(({ edit }) => edit.id === editId);
      if (row && this.repo) return this.panels.show({ edit: row.edit, turn: thread.turn, root: this.repo.root });
    }
    return undefined;
  }

  getTreeItem(node: Node): vscode.TreeItem {
    if (node.kind === 'edit') {
      // Labels are plain text: nothing here renders Markdown or icons from record content.
      const item = new vscode.TreeItem({ label: node.row.label }, vscode.TreeItemCollapsibleState.None);
      item.description = node.row.description;
      item.iconPath = new vscode.ThemeIcon('diff');
      item.command = { command: OPEN_FROM_VIEW, title: 'Open thread', arguments: [node.row.edit.id] };
      return item;
    }
    const { thread } = node;
    const item = new vscode.TreeItem({ label: thread.label }, vscode.TreeItemCollapsibleState.Collapsed);
    item.description = thread.description;
    item.tooltip = thread.tooltip;
    item.iconPath = new vscode.ThemeIcon('comment-discussion');
    item.command = { command: OPEN_FROM_VIEW, title: 'Open thread', arguments: [thread.newest.id] };
    return item;
  }

  async getChildren(node?: Node): Promise<Node[]> {
    if (node) return node.kind === 'thread' ? node.thread.edits.map((row) => ({ kind: 'edit', thread: node.thread, row })) : [];
    const document = this.document;
    let found: Awaited<ReturnType<ThreadsView['threadsFor']>>;
    try {
      found = document ? await this.threadsFor(document) : undefined;
    } catch (error) {
      console.warn('Thread Trace: could not list threads', error);
    }
    this.repo = found?.repo;
    this.threads = found?.threads ?? [];
    this.view.description = document?.uri.scheme === 'file' ? path.basename(document.uri.fsPath) : undefined;
    return this.threads.map((thread) => ({ kind: 'thread', thread }));
  }

  dispose(): void {
    for (const disposable of this.disposables) disposable.dispose();
  }
}
