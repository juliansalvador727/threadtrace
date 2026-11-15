// The VS Code side of git access: finds the git binary through the built-in
// vscode.git extension and keeps one store and resolver per repo.
import * as path from 'node:path';
import * as vscode from 'vscode';
import { findRepo, repoRelative, type RepoInfo } from '../capture/gitDir';
import { Resolver } from '../resolve/resolver';
import { TraceStore } from '../store/traceStore';
import { Git } from './exec';

// The parts of the vscode.git extension API used here.
interface GitApi {
  git: { path: string };
  toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

export interface RepoServices {
  /** Working tree root. */
  root: string;
  git: Git;
  store: TraceStore;
  resolver: Resolver;
}

export class GitService implements vscode.Disposable {
  private api: Promise<GitApi | undefined> | undefined;
  private readonly repos = new Map<string, RepoServices>();
  private readonly recordsChanged = new vscode.EventEmitter<void>();
  /** Fires when a repo's record files change on disk. */
  readonly onDidChangeRecords = this.recordsChanged.event;

  /** The repo services for a file, and its repo-relative path. Undefined outside a git repo. */
  async forFile(fsPath: string): Promise<{ repo: RepoServices; file: string } | undefined> {
    const info = findRepo(path.dirname(fsPath));
    if (!info) return undefined;
    const file = repoRelative(info, fsPath);
    if (!file) return undefined;
    return { repo: await this.services(info), file };
  }

  /** The repo services for the repo that contains a folder. Undefined outside a git repo. */
  async forDir(dir: string): Promise<RepoServices | undefined> {
    const info = findRepo(dir);
    return info && this.services(info);
  }

  private async services(info: RepoInfo): Promise<RepoServices> {
    let repo = this.repos.get(info.root);
    if (!repo) {
      const api = await this.gitApi();
      // Another call may have created it while this one awaited.
      repo = this.repos.get(info.root);
      if (!repo) {
        const store = new TraceStore(path.join(info.commonDir, 'thread-trace'));
        store.onDidChange(() => this.recordsChanged.fire());
        const detectMoves = () => vscode.workspace.getConfiguration('threadTrace').get<boolean>('blame.detectMoves', false);
        const git = new Git(info.root, api?.git.path || 'git');
        const resolver = new Resolver(git, store, undefined, { detectMoves });
        repo = { root: info.root, git, store, resolver };
        this.repos.set(info.root, repo);
      }
    }
    return repo;
  }

  /** A URI for the file as it is at `ref`, served by the git extension. */
  async toGitUri(uri: vscode.Uri, ref: string): Promise<vscode.Uri | undefined> {
    return (await this.gitApi())?.toGitUri(uri, ref);
  }

  dispose(): void {
    for (const repo of this.repos.values()) repo.store.dispose();
    this.repos.clear();
    this.recordsChanged.dispose();
  }

  private gitApi(): Promise<GitApi | undefined> {
    this.api ??= (async () => {
      try {
        const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
        if (!extension) return undefined;
        return (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
      } catch {
        // The git extension is disabled: fall back to `git` on the PATH.
        return undefined;
      }
    })();
    return this.api;
  }
}
