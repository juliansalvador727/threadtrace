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
