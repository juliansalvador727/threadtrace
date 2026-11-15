// Export to Agent Trace (https://agent-trace.dev, version 0.1.0). Export only:
// Thread Trace never reads these records back. Plain Node, no vscode.
//
// A trace record describes line ranges at one revision, so the export
// resolves the files as they are at HEAD, not the working tree. Prompts,
// transcript paths and anything else from the records stay on this machine;
// what leaves is the path, the line ranges, the model, the session id and the
// session link (docs/SPEC.md, "M5 decisions").
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Git } from '../git/exec';
import { fileAt } from '../git/log';
import type { Resolver } from '../resolve/resolver';
import { splitLines } from '../store/hash';
import type { Attribution } from '../store/schema';
import type { TraceStore } from '../store/traceStore';

export const AGENT_TRACE_VERSION = '0.1.0';
/** Where the records go, relative to the repo root. The spec leaves storage open; this is the common convention. */
export const AGENT_TRACE_FILE = '.agent-trace/traces.jsonl';
/** Marks the records this extension wrote (the spec asks vendors to namespace their metadata). */
export const METADATA_KEY = 'juliansalvador727.thread-trace';

const MAX_FILE_CHARS = 5_000_000;
const MAX_LINES = 10_000;

export interface TraceContributor {
  type: 'human' | 'ai' | 'mixed' | 'unknown';
  model_id?: string;
}

export interface TraceRange {
  /** 1-indexed, inclusive. */
  start_line: number;
  end_line: number;
}

export interface TraceConversation {
  url?: string;
  contributor: TraceContributor;
  ranges: TraceRange[];
}

export interface TraceRecord {
  version: string;
  id: string;
  timestamp: string;
  vcs: { type: 'git'; revision: string };
  tool?: { name: string; version?: string };
  files: { path: string; conversations: TraceConversation[] }[];
  metadata: Record<string, unknown>;
}

/** `claude-opus-5-5` → `anthropic/claude-opus-5-5` (the models.dev `provider/model` form the spec asks for). */
export function modelId(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const id = model.replace(/\[[^\]]*\]$/, '');
  if (id.includes('/')) return id.slice(0, 250);
  return (id.startsWith('claude-') ? `anthropic/${id}` : id).slice(0, 250);
}

interface LineSource {
  /** One record per conversation: a recorded session, or what a commit's trailers name. */
  record: string;
  session_id?: string;
  source: 'record' | 'commit-trailer';
  tool?: { name: string; version?: string };
  url?: string;
  contributor: TraceContributor;
  /** ISO time of the edit or commit behind the line. */
  ts: string;
}

function sourceOf(attribution: Attribution): LineSource | undefined {
  const { confidence, edit, turn, commit } = attribution;
  if (confidence === 'commit' && commit) {
    const url = commit.trailers.session;
    return {
      record: `trailer:${url ?? commit.trailers.coAuthor ?? ''}`,
      source: 'commit-trailer',
      url,
      // The trailer names an agent, not a model id.
      contributor: { type: 'ai' },
      ts: new Date(commit.time * 1000).toISOString(),
    };
  }
  if (!edit || confidence === 'none') return undefined;
  const threadUrl = turn?.thread_url?.startsWith('https://') ? turn.thread_url : undefined;
  const model_id = modelId(edit.model);
  return {
    record: `session:${edit.session_id}`,
    session_id: edit.session_id,
    source: 'record',
    tool: { name: turn?.agent.name ?? 'claude-code', ...(turn?.agent.version ? { version: turn.agent.version } : {}) },
    url: threadUrl ?? commit?.trailers.session,
    // The spec's `mixed` is "human-edited AI output", which is what `modified` means here.
    contributor: { type: confidence === 'modified' ? 'mixed' : 'ai', ...(model_id ? { model_id } : {}) },
    ts: edit.ts,
  };
}

export interface ResolvedFile {
  /** Repo-relative, POSIX separators. */
  path: string;
  /** Entry `i` is line `i + 1` of the file at the revision. */
  attributions: Attribution[];
}

/**
 * Trace records for one revision: one per conversation, each listing the
 * files and line ranges that conversation still owns. Lines no agent is known
 * to have written are left out.
 */
export function buildTraceRecords(revision: string, files: ResolvedFile[], newId: () => string = randomUUID): TraceRecord[] {
  interface Draft {
    first: LineSource;
    newest: string;
    files: Map<string, Map<string, TraceConversation>>;
  }
  const drafts = new Map<string, Draft>();
  for (const file of files) {
    let open: { key: string; range: TraceRange } | undefined;
    file.attributions.forEach((attribution, index) => {
      const line = index + 1;
      const source = sourceOf(attribution);
      if (!source) {
        open = undefined;
        return;
      }
      const conversationKey = `${source.url ?? ''}\n${source.contributor.type}\n${source.contributor.model_id ?? ''}`;
      const key = `${source.record}\n${conversationKey}`;
      let draft = drafts.get(source.record);
      if (!draft) drafts.set(source.record, (draft = { first: source, newest: source.ts, files: new Map() }));
      if (source.ts > draft.newest) draft.newest = source.ts;
      // Consecutive lines from the same conversation and contributor are one range.
      if (open?.key === key && open.range.end_line === line - 1) {
        open.range.end_line = line;
        return;
      }
      let conversations = draft.files.get(file.path);
      if (!conversations) draft.files.set(file.path, (conversations = new Map()));
      let conversation = conversations.get(conversationKey);
      if (!conversation) {
        conversation = { ...(source.url ? { url: source.url } : {}), contributor: source.contributor, ranges: [] };
        conversations.set(conversationKey, conversation);
      }
      const range = { start_line: line, end_line: line };
      conversation.ranges.push(range);
      open = { key, range };
    });
  }
  return [...drafts.values()].map(({ first, newest, files: byFile }) => ({
    version: AGENT_TRACE_VERSION,
    id: newId(),
    timestamp: newest,
    vcs: { type: 'git', revision },
    ...(first.tool ? { tool: first.tool } : {}),
    files: [...byFile].map(([file, conversations]) => ({ path: file, conversations: [...conversations.values()] })),
    metadata: { [METADATA_KEY]: { source: first.source, ...(first.session_id ? { session_id: first.session_id } : {}) } },
  }));
}

export interface TraceTotals {
  records: number;
  files: number;
  ranges: number;
  lines: number;
}

export function traceTotals(records: TraceRecord[]): TraceTotals {
  const files = new Set<string>();
  let ranges = 0;
  let lines = 0;
  for (const record of records) {
    for (const file of record.files) {
      files.add(file.path);
      for (const conversation of file.conversations) {
        for (const range of conversation.ranges) {
          ranges++;
          lines += range.end_line - range.start_line + 1;
        }
      }
    }
  }
  return { records: records.length, files: files.size, ranges, lines };
}

function isOwnRecordAt(line: string, revision: string): boolean {
  try {
    const record = JSON.parse(line) as Partial<TraceRecord> | null;
    return !!record && typeof record === 'object' && record.vcs?.revision === revision && !!record.metadata && METADATA_KEY in record.metadata;
  } catch {
    return false;
  }
}

/**
 * The new text of the traces file. Records other tools wrote, and this
 * extension's records for other revisions, are kept as they are; its earlier
 * records for `revision` are replaced, so exporting twice doesn't double up.
 */
export function mergeTraceFile(existing: string | undefined, records: TraceRecord[], revision: string): string {
  const kept = (existing ?? '').split('\n').filter((line) => line.trim() !== '' && !isOwnRecordAt(line, revision));
  return [...kept, ...records.map((record) => JSON.stringify(record))].map((line) => `${line}\n`).join('');
}

export interface TraceExport {
  /** The commit the ranges refer to. */
  revision: string;
  records: TraceRecord[];
  totals: TraceTotals;
  /** Files with records that were left out: not at HEAD under that name, binary, or too large. */
  skipped: number;
  cancelled: boolean;
}

export interface ExportOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/**
 * Resolves every file that has edit records, as it is at HEAD, and builds the
 * records. Writes nothing. Undefined when the repo has no commit yet.
 */
export async function collectAgentTrace(git: Git, store: TraceStore, resolver: Resolver, options: ExportOptions = {}): Promise<TraceExport | undefined> {
  const head = await git.run(['rev-parse', '--verify', 'HEAD']);
  const revision = head.stdout.trim();
  if (head.code !== 0 || !/^[0-9a-f]{40,64}$/.test(revision)) return undefined;
  const listed = await git.run(['ls-tree', '-r', '--name-only', '-z', revision]);
  if (listed.code !== 0) throw new Error(`git ls-tree failed: ${listed.stderr.trim()}`);
  const tracked = new Set(listed.stdout.split('\0'));

  store.refresh();
  const candidates = store.files().sort();
  const resolved: ResolvedFile[] = [];
  let skipped = 0;
  let done = 0;
  let cancelled = false;
  for (const file of candidates) {
    if (options.signal?.aborted) {
      cancelled = true;
      break;
    }
    options.onProgress?.(done++, candidates.length);
    const text = tracked.has(file) ? await fileAt(git, revision, file) : undefined;
    if (text === undefined || text.length > MAX_FILE_CHARS || text.includes('\0') || splitLines(text).length > MAX_LINES) {
      skipped++;
      continue;
    }
    resolved.push({ path: file, attributions: await resolver.resolveFile({ file, text }) });
  }
  const records = buildTraceRecords(revision, resolved);
  return { revision, records, totals: traceTotals(records), skipped, cancelled };
}

/** Writes the records into `<root>/.agent-trace/traces.jsonl`. Returns the file's path. */
export function writeAgentTrace(root: string, records: TraceRecord[], revision: string): string {
  const file = path.join(root, ...AGENT_TRACE_FILE.split('/'));
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written beside the target and renamed, so a failure can't leave half a file.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, mergeTraceFile(existing, records, revision));
  fs.renameSync(temp, file);
  return file;
}
