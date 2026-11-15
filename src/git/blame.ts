// Runs and parses `git blame --porcelain` (docs/SPEC.md, "Resolving a line").
import type { Git } from './exec';

export interface BlameLine {
  /** 1-based line in the blamed content. */
  line: number;
  /** Commit sha; all zeros when the line isn't committed. */
  sha: string;
  committed: boolean;
  /** Line number and path in the blamed commit (the path differs after a rename). */
  origLine: number;
  origPath: string;
  author: string;
  /** Seconds since the epoch. */
  authorTime: number;
  committerTime: number;
  summary: string;
  /** The commit's parent version of the file, when there is one. */
  previous?: { sha: string; path: string };
}

interface CommitFields {
  author: string;
  authorTime: number;
  committerTime: number;
  summary: string;
  previous?: { sha: string; path: string };
  filename: string;
}

const ZERO_SHA = /^0+$/;
const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: \d+)?$/;

/** Parses porcelain output. Commit fields are printed once per commit and reused for its later lines. */
export function parsePorcelain(output: string): BlameLine[] {
  const commits = new Map<string, CommitFields>();
  const result: BlameLine[] = [];
  let current: { sha: string; origLine: number; line: number } | undefined;
  for (const text of output.split('\n')) {
    if (text.startsWith('\t')) {
      // The content line ends one entry.
      if (current) {
        const fields = commits.get(current.sha)!;
        result.push({
          line: current.line,
          sha: current.sha,
          committed: !ZERO_SHA.test(current.sha),
          origLine: current.origLine,
          origPath: fields.filename,
          author: fields.author,
          authorTime: fields.authorTime,
          committerTime: fields.committerTime,
          summary: fields.summary,
          previous: fields.previous,
        });
      }
      current = undefined;
      continue;
    }
    if (!current) {
      const header = HEADER.exec(text);
      if (!header) continue;
      current = { sha: header[1], origLine: Number(header[2]), line: Number(header[3]) };
      if (!commits.has(current.sha)) {
        commits.set(current.sha, { author: '', authorTime: 0, committerTime: 0, summary: '', filename: '' });
      }
      continue;
    }
    const fields = commits.get(current.sha)!;
    const space = text.indexOf(' ');
    const key = space === -1 ? text : text.slice(0, space);
    const value = space === -1 ? '' : text.slice(space + 1);
    if (key === 'author') fields.author = value;
    else if (key === 'author-time') fields.authorTime = Number(value);
    else if (key === 'committer-time') fields.committerTime = Number(value);
    else if (key === 'summary') fields.summary = value;
    else if (key === 'filename') fields.filename = value;
    else if (key === 'previous') {
      const split = value.indexOf(' ');
      if (split !== -1) fields.previous = { sha: value.slice(0, split), path: value.slice(split + 1) };
    }
  }
  return result;
}

function uncommitted(file: string, from: number, to: number): BlameLine[] {
  const lines: BlameLine[] = [];
  for (let line = from; line <= to; line++) {
    lines.push({
      line,
      sha: '0'.repeat(40),
      committed: false,
      origLine: line,
      origPath: file,
      author: '',
      authorTime: 0,
      committerTime: 0,
      summary: '',
    });
  }
  return lines;
}

// git's messages for a file or repo with nothing committed yet.
const NOTHING_COMMITTED = /no such path|no such ref|bad revision|does not have any commits|not a valid object name/i;

/**
 * Blames lines `from`..`to` (1-based, inclusive) of `contents`, the text on
 * screen, so unsaved changes resolve with the line numbers the user sees.
 * A file git has never committed comes back as all-uncommitted. Throws when
 * git fails for any other reason.
 */
export async function blameLines(
  git: Git,
  file: string,
  from: number,
  to: number,
  contents: string,
): Promise<BlameLine[]> {
  const result = await git.run(['blame', '--porcelain', '-L', `${from},${to}`, '--contents', '-', '--', file], contents);
  if (result.code === 0) return parsePorcelain(result.stdout);
  if (NOTHING_COMMITTED.test(result.stderr)) return uncommitted(file, from, to);
  throw new Error(`git blame failed (${result.code}): ${result.stderr.trim()}`);
}
