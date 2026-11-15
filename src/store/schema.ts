// Record types from docs/SPEC.md, "Data model". Types only; no behavior.

export interface Turn {
  v: 1;
  /** `${session_id}:${turnIndex}` */
  id: string;
  agent: { name: 'claude-code' | (string & {}); version?: string };
  session_id: string;
  /** e.g. https://claude.ai/code/session_… when known */
  thread_url?: string;
  transcript_path?: string;
  /** Transcript entry uuid, for jump-to. */
  prompt_entry_id?: string;
  /** Full prompt, first line, or '' per settings, after redaction. */
  prompt: string;
  /** ISO 8601 */
  ts: string;
  cwd: string;
  git: { head: string; branch?: string };
  source: 'hook' | 'backfill';
}

export interface Hunk {
  /** 1-based, post-edit. Absent for backfill. */
  start?: number;
  end?: number;
  hashes: string[];
}

export interface Edit {
  v: 1;
  /** ulid */
  id: string;
  turn_id: string;
  session_id: string;
  /** Jump target inside the transcript. */
  tool_use_id?: string;
  tool: 'Edit' | 'Write' | 'MultiEdit' | (string & {});
  /** e.g. 'claude-opus-5-5' */
  model?: string;
  /** Repo-relative, POSIX separators. */
  file: string;
  ts: string;
  hunks: Hunk[];
  removed_hashes?: string[];
  base_head: string;
  source: 'hook' | 'backfill';
}

export type Confidence = 'exact' | 'likely' | 'modified' | 'commit' | 'none';

export interface CommitInfo {
  sha: string;
  author: string;
  time: number;
  summary: string;
  trailers: { session?: string; coAuthor?: string };
}

export interface Attribution {
  line: number;
  confidence: Confidence;
  edit?: Edit;
  turn?: Turn;
  commit?: CommitInfo;
  /** Older threads/commits for this line, newest first. */
  history: Attribution[];
}
