// A line's commit chain (`git log -L`) and file contents at a commit.
// The rename map (`git log --follow`) is not built yet: blame's original path
// covers committed renames.
import type { CommitInfo } from '../store/schema';
import type { Git } from './exec';

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
    '--format=%x01%H%x00%an%x00%at%x00%s',
    '-n',
    String(limit),
    sha,
  ]);
  if (result.code !== 0) return [];
  const commits: CommitInfo[] = [];
  // -L prints a patch after each header; only the lines we formatted start with RECORD.
  for (const text of result.stdout.split('\n')) {
    if (!text.startsWith(RECORD)) continue;
    const [commit, author, time, summary] = text.slice(1).split(FIELD);
    if (!commit) continue;
    commits.push({ sha: commit, author: author ?? '', time: Number(time) || 0, summary: summary ?? '', trailers: {} });
  }
  return commits;
}

/** The text of `path` at commit `rev`, or undefined when it doesn't exist there. */
export async function fileAt(git: Git, rev: string, path: string): Promise<string | undefined> {
  const result = await git.run(['show', `${rev}:${path}`]);
  return result.code === 0 ? result.stdout : undefined;
}
