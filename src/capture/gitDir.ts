// Finds the repo and reads HEAD by reading files under .git directly.
// The hook never spawns git, so it stays fast.
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RepoInfo {
  /** Working tree root. */
  root: string;
  /** This working tree's git dir (differs from commonDir in a linked worktree). */
  gitDir: string;
  /** The shared git dir, where refs and thread-trace records live. */
  commonDir: string;
}

export interface HeadInfo {
  /** Commit sha, or '' on a branch with no commits yet. */
  head: string;
  branch?: string;
}

function readTrimmed(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return undefined;
  }
}

/** Walks up from `startDir` to the nearest directory that contains `.git`. */
export function findRepo(startDir: string): RepoInfo | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat) {
      let gitDir = dotGit;
      if (stat.isFile()) {
        // Linked worktree or submodule: `.git` is a file that points at the real git dir.
        const match = /^gitdir:\s*(.+)$/m.exec(readTrimmed(dotGit) ?? '');
        if (!match) return undefined;
        gitDir = path.resolve(dir, match[1].trim());
      }
      const common = readTrimmed(path.join(gitDir, 'commondir'));
      const commonDir = common ? path.resolve(gitDir, common) : gitDir;
      return { root: dir, gitDir, commonDir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function resolveRef(repo: RepoInfo, ref: string): string {
  for (const base of new Set([repo.gitDir, repo.commonDir])) {
    const sha = readTrimmed(path.join(base, ref));
    if (sha && /^[0-9a-f]{40,64}$/.test(sha)) return sha;
  }
  const packed = readTrimmed(path.join(repo.commonDir, 'packed-refs'));
  if (packed) {
    for (const line of packed.split('\n')) {
      if (line.endsWith(` ${ref}`)) return line.slice(0, line.indexOf(' '));
    }
  }
  return '';
}

export function readHead(repo: RepoInfo): HeadInfo {
  const head = readTrimmed(path.join(repo.gitDir, 'HEAD')) ?? '';
  const match = /^ref:\s*(.+)$/.exec(head);
  if (!match) return { head };
  const ref = match[1].trim();
  return { head: resolveRef(repo, ref), branch: ref.replace(/^refs\/heads\//, '') };
}

/** Repo-relative path with POSIX separators, or undefined when the file isn't tracked content of this repo. */
export function repoRelative(repo: RepoInfo, file: string): string | undefined {
  const relative = path.relative(repo.root, path.resolve(file));
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const posix = relative.split(path.sep).join('/');
  if (posix === '.git' || posix.startsWith('.git/')) return undefined;
  return posix;
}
