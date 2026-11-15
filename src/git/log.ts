// A line's commit chain (`git log -L`), a file's former paths
// (`git log --follow`) and file contents at a commit.
import type { CommitInfo } from '../store/schema';
import type { Git } from './exec';
import { parseTrailers, TRAILERS_FORMAT } from './trailers';

const RECORD = '\x01';
const FIELD = '\x00';

/**
 * Commits that changed line `line` of `path` as it is in commit `sha`, newest
 * first, starting with the commit that last changed it. Empty on failure.
 */
export async function lineHistory(git: Git, sha: string, path: string, line: number, limit = 20): Promise<CommitInfo[]> {
  const result = await git.run([
    'log',
    `-L${line},${line}:${path}`,
    // git expands %x01 and %x00 itself; an argument can't hold a raw NUL.
    `--format=%x01%H%x00%an%x00%at%x00%s%x00${TRAILERS_FORMAT}`,
    '-n',
    String(limit),
    sha,
  ]);
  if (result.code !== 0) return [];
  const commits: CommitInfo[] = [];
  // -L prints a patch after each header; only the lines we formatted start with RECORD.
  for (const text of result.stdout.split('\n')) {
    if (!text.startsWith(RECORD)) continue;
    const [commit, author, time, summary, trailers] = text.slice(1).split(FIELD);
    if (!commit) continue;
    commits.push({ sha: commit, author: author ?? '', time: Number(time) || 0, summary: summary ?? '', trailers: parseTrailers(trailers ?? '') });
  }
  return commits;
}

/** The text of `path` at commit `rev`, or undefined when it doesn't exist there. */
export async function fileAt(git: Git, rev: string, path: string): Promise<string | undefined> {
  const result = await git.run(['show', `${rev}:${path}`]);
  return result.code === 0 ? result.stdout : undefined;
}

/**
 * Paths `file` had before it was renamed, newest first. Committed renames
 * only; a `git mv` that isn't committed yet is not in the log. Empty on failure.
 */
export async function formerPaths(git: Git, file: string): Promise<string[]> {
  // quotePath=false keeps non-ASCII paths as they are instead of octal-escaping them.
  const result = await git.run(['-c', 'core.quotePath=false', 'log', '--follow', '--name-status', '--format=', '--', file]);
  if (result.code !== 0) return [];
  const paths: string[] = [];
  for (const text of result.stdout.split('\n')) {
    // `R100<TAB>old<TAB>new`
    const [status, from] = text.split('\t');
    if (!status?.startsWith('R') || !from || from === file || paths.includes(from)) continue;
    paths.push(from);
  }
  return paths;
}

/** Where a file was on each side of a commit's diff. A missing side means the file didn't exist there. */
export interface CommitFileChange {
  /** Path in the commit's first parent; undefined when the commit added the file or has no parent. */
  before?: string;
  /** Path in the commit itself. */
  after: string;
}

/**
 * Finds the file a commit changed, given the file's current path: under that
 * path or one of its former names in the commit, and under the name it had in
 * the first parent (renames followed, added files and root commits have none).
 * Undefined when the file isn't in the commit at all.
 */
export async function commitFileChange(git: Git, sha: string, file: string): Promise<CommitFileChange | undefined> {
  let after: string | undefined;
  for (const candidate of [file, ...(await formerPaths(git, file))]) {
    if ((await git.run(['cat-file', '-e', `${sha}:${candidate}`])).code === 0) {
      after = candidate;
      break;
    }
  }
  if (!after) return undefined;
  const parent = `${sha}^1`;
  if ((await git.run(['rev-parse', '--verify', '--quiet', `${parent}^{commit}`])).code !== 0) return { after };
  // Two trees, so a merge is compared with its first parent. -z keeps paths unquoted.
  const diff = await git.run(['diff-tree', '-r', '-M', '-z', '--name-status', parent, sha]);
  if (diff.code === 0) {
    const fields = diff.stdout.split('\0');
    for (let i = 0; i < fields.length; ) {
      const status = fields[i++];
      if (!status) break;
      const paths = status.startsWith('R') || status.startsWith('C') ? [fields[i++], fields[i++]] : [fields[i++]];
      if (paths[paths.length - 1] !== after) continue;
      if (status.startsWith('A')) return { after };
      if (status.startsWith('R')) return { before: paths[0], after };
      break;
    }
  }
  // Modified, or unchanged against the first parent (a merge): same path on both sides, if it's there.
  return (await git.run(['cat-file', '-e', `${parent}:${after}`])).code === 0 ? { before: after, after } : { after };
}
