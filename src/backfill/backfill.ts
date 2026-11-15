// Imports attribution from transcripts that already exist on this machine
// (docs/SPEC.md, "Transcript backfill" and "M4 decisions"). It writes the same
// records as the hook, tagged `source: 'backfill'`.
//
// Plain Node, no vscode. Append-only: an edit that is already recorded, by the
// hook or by an earlier run, is skipped, so running it again adds nothing.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { claudeCode } from '../adapters/claudeCode';
import type { AgentAdapter, TranscriptEdit, TranscriptFile, TranscriptPrompt } from '../adapters/types';
import { lineChanges, loadConfig, turnId, ulid, type CaptureConfig } from '../capture/capture';
import { repoRelative, type RepoInfo } from '../capture/gitDir';
import { preparePrompt } from '../capture/redact';
import type { Edit, Turn } from '../store/schema';

export interface BackfillOptions {
  /** CLAUDE_CONFIG_DIR and THREAD_TRACE_HOME are honoured (tests set both). */
  env: NodeJS.ProcessEnv;
  /** Checked between transcripts. */
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  adapter?: Pick<AgentAdapter, 'name' | 'findTranscripts' | 'readTranscriptEvents'>;
}

export interface BackfillResult {
  /** Transcript files read. */
  transcripts: number;
  /** Sessions that gained at least one edit record. */
  sessions: number;
  /** Records appended. */
  edits: number;
  turns: number;
  /** Edits already recorded by the hook or an earlier backfill. */
  existing: number;
  /** Edit calls left out: rejected, without a result, or to a file outside the repo. */
  skipped: number;
  cancelled: boolean;
}

function readLines(file: string): string[] {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

const TOOL_USE_ID = /"tool_use_id":"([^"\\]+)"/;

/** What is already recorded: the tool calls behind the edits, and the turn ids. */
function recorded(dir: string): { toolUses: Set<string>; turns: Set<string> } {
  const toolUses = new Set<string>();
  for (const line of readLines(path.join(dir, 'edits.jsonl'))) {
    const match = TOOL_USE_ID.exec(line);
    if (match) toolUses.add(match[1]);
  }
  const turns = new Set<string>();
  for (const line of readLines(path.join(dir, 'turns.jsonl'))) {
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === 'string') turns.add(id);
    } catch {
      // Not a record.
    }
  }
  return { toolUses, turns };
}

/** The prompt an edit answers: the one with its prompt id, else the last one submitted before it. */
function promptFor(edit: TranscriptEdit, prompts: TranscriptPrompt[]): TranscriptPrompt | undefined {
  if (edit.prompt_id) {
    const same = prompts.find((prompt) => prompt.prompt_id === edit.prompt_id);
    if (same) return same;
  }
  let last: TranscriptPrompt | undefined;
  for (const prompt of prompts) {
    if (prompt.ts && prompt.ts <= edit.ts) last = prompt;
  }
  return last;
}

function promptKey(prompt: TranscriptPrompt): string | undefined {
  return prompt.prompt_id ?? prompt.entry_id;
}

function turnRecord(prompt: TranscriptPrompt, id: string, agent: string, config: CaptureConfig, fallbackTs: string): Turn {
  return {
    v: 1,
    id,
    agent: { name: agent, version: prompt.version },
    session_id: prompt.session_id,
    transcript_path: prompt.transcript_path,
    prompt_entry_id: prompt.entry_id,
    prompt: prompt.human ? preparePrompt(prompt.prompt, config.prompt, config.redact) : '',
    origin: prompt.human ? 'human' : 'agent',
    ts: prompt.ts ?? fallbackTs,
    cwd: prompt.cwd,
    // The transcript doesn't say which commit was checked out.
    git: { head: '', branch: prompt.branch },
    source: 'backfill',
  };
}

function append(dir: string, file: 'turns.jsonl' | 'edits.jsonl', records: (Turn | Edit)[]): void {
  if (records.length === 0) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, file), records.map((record) => JSON.stringify(record) + '\n').join(''));
}

const nextTick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Reads the repo's transcripts and appends a record for every applied edit that isn't recorded yet. */
export async function backfill(repo: RepoInfo, options: BackfillOptions): Promise<BackfillResult> {
  const adapter = options.adapter ?? claudeCode;
  const config = loadConfig(options.env);
  const dir = path.join(repo.commonDir, 'thread-trace');
  const known = recorded(dir);
  const files: TranscriptFile[] = adapter.findTranscripts(repo.root, options.env);
  const result: BackfillResult = { transcripts: 0, sessions: 0, edits: 0, turns: 0, existing: 0, skipped: 0, cancelled: false };
  /** Each session's prompts, from its main transcript, for the subagent files that follow it. */
  const sessionPrompts = new Map<string, TranscriptPrompt[]>();
  const sessions = new Set<string>();

  for (let i = 0; i < files.length; i++) {
    if (options.signal?.aborted) {
      result.cancelled = true;
      break;
    }
    const file = files[i];
    const events = adapter.readTranscriptEvents(file);
    options.onProgress?.(i + 1, files.length);
    if (!events) continue;
    result.transcripts++;
    result.skipped += events.skipped;
    if (!file.agent_id) sessionPrompts.set(file.main, events.prompts);
    // A subagent's own transcript holds its task, not the user's prompt.
    const prompts = file.agent_id ? (sessionPrompts.get(file.main) ?? []) : events.prompts;

    const turns: Turn[] = [];
    const edits: Edit[] = [];
    for (const event of events.edits) {
      if (!event.tool_use_id) {
        result.skipped++;
        continue;
      }
      if (known.toolUses.has(event.tool_use_id)) {
        result.existing++;
        continue;
      }
      // Writes outside the repo (a scratch file, a plan) are in transcripts too.
      const relative = repoRelative(repo, event.file_path);
      const changes = relative ? lineChanges(event, false) : undefined;
      if (!relative || !changes || (changes.hunks.length === 0 && changes.removed_hashes.length === 0)) {
        result.skipped++;
        continue;
      }
      const prompt = promptFor(event, prompts);
      const key = prompt ? promptKey(prompt) : event.prompt_id;
      const id = turnId(event.session_id, key);
      if (prompt && !known.turns.has(id)) {
        known.turns.add(id);
        turns.push(turnRecord(prompt, id, adapter.name, config, event.ts));
      }
      known.toolUses.add(event.tool_use_id);
      edits.push({
        v: 1,
        id: ulid(Date.parse(event.ts) || Date.now()),
        turn_id: id,
        session_id: event.session_id,
        tool_use_id: event.tool_use_id,
        agent_id: event.agent_id,
        tool: event.tool,
        model: event.model,
        file: relative,
        ts: event.ts,
        hunks: changes.hunks,
        removed_hashes: changes.removed_hashes.length > 0 ? changes.removed_hashes : undefined,
        base_head: '',
        source: 'backfill',
      });
    }
    // Turns first, so a reader that sees an edit can already find its turn.
    append(dir, 'turns.jsonl', turns);
    append(dir, 'edits.jsonl', edits);
    result.turns += turns.length;
    result.edits += edits.length;
    if (edits.length > 0) sessions.add(file.main);
    // Reading a transcript is synchronous; let the extension host breathe between files.
    await nextTick();
  }
  result.sessions = sessions.size;
  return result;
}
