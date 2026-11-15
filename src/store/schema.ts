// Record types from docs/SPEC.md, "Data model". Types only; no behavior.

export interface Turn {
  v: 1;
  /** `${session_id}:${prompt_id}`. The prompt_id comes from the hook payload, so edits link without shared state. */
  id: string;
  agent: { name: 'claude-code' | (string & {}); version?: string };
  session_id: string;
  /** e.g. https://claude.ai/code/session_… when known */
  thread_url?: string;
  transcript_path?: string;
  /** Transcript entry uuid, for jump-to. */
  prompt_entry_id?: string;
  /** Full prompt, first line, or '' per settings, after redaction. Always '' when origin is 'agent'. */
  prompt: string;
  /** 'agent' for prompts the agent submitted itself, e.g. a background-task notification. */
  origin?: 'human' | 'agent';
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
  /** Strict hash per written line. */
  hashes: string[];
  /** Loose (whitespace-insensitive) hash per written line, parallel to `hashes`. */
  loose?: string[];
}

export interface Edit {
  v: 1;
  /** ulid */
  id: string;
  turn_id: string;
  session_id: string;
  /** Jump target inside the transcript. */
  tool_use_id?: string;
  /** Set when a subagent made the edit; its entries are in a separate transcript. */
  agent_id?: string;
  tool: 'Edit' | 'Write' | 'MultiEdit' | (string & {});
  /** e.g. 'claude-opus-5-5'. Best effort from the hook; the read layer corrects it by tool_use_id. */
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
