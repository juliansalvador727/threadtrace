// The capture logic behind the tt-capture hook: turns one hook payload into one
// appended JSON line under <git dir>/thread-trace/.
//
// Rules (docs/SPEC.md, "Hook rules"): never throw to the caller, never write to
// stdout, append only, no git subprocess, log failures to ~/.thread-trace/capture.log.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { claudeCode } from '../adapters/claudeCode';
import type { EditEvent } from '../adapters/types';
import type { Edit, Turn } from '../store/schema';
import { findRepo, readHead, repoRelative, type RepoInfo } from './gitDir';
import { changesFromNewFile, changesFromPatch, changesFromSearch, changesFromText, type LineChanges } from './lineRanges';
import { compilePatterns, preparePrompt, type PromptMode } from './redact';

export type CaptureMode = 'prompt' | 'edit';

export interface CaptureEnv {
  /** Process environment. THREAD_TRACE_HOME overrides ~/.thread-trace (used by tests). */
  env: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface CaptureConfig {
  prompt: PromptMode;
  redact: RegExp[];
}

export function traceHome(env: NodeJS.ProcessEnv): string {
  return env.THREAD_TRACE_HOME || path.join(os.homedir(), '.thread-trace');
}

/** Optional ~/.thread-trace/config.json, written by the extension from its settings. */
export function loadConfig(env: NodeJS.ProcessEnv): CaptureConfig {
  const config: CaptureConfig = { prompt: 'full', redact: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(traceHome(env), 'config.json'), 'utf8'));
    if (raw && typeof raw === 'object') {
      if (raw.prompt === 'full' || raw.prompt === 'firstLine' || raw.prompt === 'none') config.prompt = raw.prompt;
      config.redact = compilePatterns(raw.redact);
    }
  } catch {
    // No config, or an unreadable one: use the defaults.
  }
  return config;
}

export function logFailure(env: NodeJS.ProcessEnv, mode: string, error: unknown): void {
  try {
    const home = traceHome(env);
    fs.mkdirSync(home, { recursive: true });
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    fs.appendFileSync(path.join(home, 'capture.log'), `${new Date().toISOString()} [${mode}] ${message}\n`);
  } catch {
    // Logging must never fail the hook.
  }
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID: 48-bit millisecond timestamp plus 80 random bits, in Crockford base32. */
export function ulid(time = Date.now()): string {
  let timePart = '';
  let t = time;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[t % 32] + timePart;
    t = Math.floor(t / 32);
  }
  let randomPart = '';
  for (const byte of randomBytes(16)) randomPart += CROCKFORD[byte % 32];
  return timePart + randomPart;
}

function appendRecord(repo: RepoInfo, file: 'turns.jsonl' | 'edits.jsonl', record: Turn | Edit): void {
  const dir = path.join(repo.commonDir, 'thread-trace');
  fs.mkdirSync(dir, { recursive: true });
  // One write call with O_APPEND, so concurrent hooks don't interleave lines.
  fs.appendFileSync(path.join(dir, file), JSON.stringify(record) + '\n');
}

/** `${session_id}:${prompt_id}`. Edits carry the same prompt_id, so no state is needed to link them. */
export function turnId(sessionId: string, promptId: string | undefined): string {
  return `${sessionId}:${promptId ?? 'unknown'}`;
}

function capturePrompt(payload: unknown, { env, now }: CaptureEnv): void {
  const event = claudeCode.parsePromptPayload(payload);
  if (!event) throw new Error('unrecognized prompt payload');
  const repo = findRepo(event.cwd);
  if (!repo) return; // Not a git repo: nothing to attribute.
  const config = loadConfig(env);
  const head = readHead(repo);
  const turn: Turn = {
    v: 1,
    id: turnId(event.session_id, event.prompt_id),
    agent: { name: claudeCode.name, version: claudeCode.version(env) },
    session_id: event.session_id,
    transcript_path: event.transcript_path,
    // A synthetic prompt (e.g. a background-task notification) isn't the user's
    // words, so its text isn't stored. The turn is still recorded so that edits
    // made in response to it have something to link to.
    prompt: event.human ? preparePrompt(event.prompt, config.prompt, config.redact) : '',
    origin: event.human ? 'human' : 'agent',
    ts: (now?.() ?? new Date()).toISOString(),
    cwd: event.cwd,
    git: head,
    source: 'hook',
  };
  appendRecord(repo, 'turns.jsonl', turn);
}

/**
 * The lines an edit wrote and removed. `locate: false` is for backfill, where
 * the file on disk is no longer what the edit left behind: without a patch
 * the hashes are recorded with no positions.
 */
export function lineChanges(event: EditEvent, locate = true): LineChanges {
  if (event.patch) return changesFromPatch(event.patch);
  if (event.created_content !== undefined) return changesFromNewFile(event.created_content);
  if (!locate) {
    const merged: LineChanges = { hunks: [], removed_hashes: [] };
    for (const r of event.replacements) {
      const changes = changesFromText(r.old_string, r.new_string);
      merged.hunks.push(...changes.hunks);
      merged.removed_hashes.push(...changes.removed_hashes);
    }
    return merged;
  }
  // No patch in the payload: locate the replacements in the file as it is now.
  let fileText = '';
  try {
    fileText = fs.readFileSync(event.file_path, 'utf8');
  } catch {
    // The hashes are still worth recording without positions.
  }
  const merged: LineChanges = { hunks: [], removed_hashes: [] };
  for (const r of event.replacements) {
    const changes = changesFromSearch(fileText, r.old_string, r.new_string, r.replace_all);
    merged.hunks.push(...changes.hunks);
    merged.removed_hashes.push(...changes.removed_hashes);
  }
  return merged;
}

function captureEdit(payload: unknown, { now }: CaptureEnv): void {
  const event = claudeCode.parseEditPayload(payload);
  if (!event) throw new Error('unrecognized edit payload');
  const repo = findRepo(path.dirname(event.file_path));
  if (!repo) return; // File isn't in a git repo (e.g. a scratch file under /tmp).
  const file = repoRelative(repo, event.file_path);
  if (!file) return;
  const changes = lineChanges(event);
  if (changes.hunks.length === 0 && changes.removed_hashes.length === 0) return;
  const time = now?.() ?? new Date();
  const edit: Edit = {
    v: 1,
    id: ulid(time.getTime()),
    turn_id: turnId(event.session_id, event.prompt_id),
    session_id: event.session_id,
    tool_use_id: event.tool_use_id,
    agent_id: event.agent_id,
    tool: event.tool,
    // Best effort: the entry for this tool call isn't in the transcript yet.
    // The read layer corrects it by matching tool_use_id (M2).
    model: claudeCode.modelAtHookTime(event),
    file,
    ts: time.toISOString(),
    hunks: changes.hunks,
    removed_hashes: changes.removed_hashes.length > 0 ? changes.removed_hashes : undefined,
    base_head: readHead(repo).head,
    source: 'hook',
  };
  appendRecord(repo, 'edits.jsonl', edit);
}

/** Runs one capture. Never throws: failures are logged and swallowed. */
export function runCapture(mode: string | undefined, rawStdin: string, capture: CaptureEnv): void {
  try {
    if (mode !== 'prompt' && mode !== 'edit') throw new Error(`unknown mode: ${String(mode)}`);
    const payload: unknown = JSON.parse(rawStdin);
    if (mode === 'prompt') capturePrompt(payload, capture);
    else captureEdit(payload, capture);
  } catch (error) {
    logFailure(capture.env, String(mode), error);
  }
}
