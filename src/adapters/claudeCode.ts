// Claude Code adapter. All knowledge of Claude Code's hook payloads and
// transcript format lives in this file; both are internals, not a stable API.
// Field names were checked against real payloads from CLI 2.1.325
// (test/fixtures/hook-payloads, docs/SPEC.md "Hook payloads observed").
//
// Node-only: the hook bundle imports this, so it must never import vscode.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { PatchHunk } from '../capture/lineRanges';
import { JsonlFollower } from '../store/jsonlTail';
import type {
  AgentAdapter,
  EditEvent,
  EditRef,
  PromptEvent,
  Thread,
  ThreadItem,
  ToolCategory,
  TranscriptEvents,
  TranscriptFile,
} from './types';

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

// Prompts Claude Code submits on its own behalf. The hook payload doesn't mark
// them, so they are recognized by their opening tag.
const SYNTHETIC_PROMPT = /^\s*<(task-notification|system-reminder)\b/;

function parsePatch(value: unknown): PatchHunk[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hunks: PatchHunk[] = [];
  for (const item of value) {
    if (!isObject(item) || !Array.isArray(item.lines)) return undefined;
    const { oldStart, oldLines, newStart, newLines } = item;
    if (typeof newStart !== 'number' || typeof oldStart !== 'number') return undefined;
    hunks.push({
      oldStart,
      oldLines: typeof oldLines === 'number' ? oldLines : 0,
      newStart,
      newLines: typeof newLines === 'number' ? newLines : 0,
      lines: item.lines.filter((line): line is string => typeof line === 'string'),
    });
  }
  return hunks;
}

function parsePromptPayload(payload: unknown): PromptEvent | undefined {
  if (!isObject(payload)) return undefined;
  const session_id = str(payload.session_id);
  if (!session_id || typeof payload.prompt !== 'string') return undefined;
  return {
    session_id,
    prompt_id: str(payload.prompt_id),
    transcript_path: str(payload.transcript_path),
    cwd: str(payload.cwd) ?? process.cwd(),
    prompt: payload.prompt,
    human: !SYNTHETIC_PROMPT.test(payload.prompt),
  };
}

function parseEditPayload(payload: unknown): EditEvent | undefined {
  if (!isObject(payload)) return undefined;
  const session_id = str(payload.session_id);
  const tool = str(payload.tool_name);
  const input = isObject(payload.tool_input) ? payload.tool_input : undefined;
  const response = isObject(payload.tool_response) ? payload.tool_response : {};
  const file_path = str(input?.file_path) ?? str(response.filePath);
  if (!session_id || !tool || !input || !file_path) return undefined;

  const replacements: EditEvent['replacements'] = [];
  const addReplacement = (source: Json) => {
    if (typeof source.new_string !== 'string') return;
    replacements.push({
      old_string: typeof source.old_string === 'string' ? source.old_string : '',
      new_string: source.new_string,
      replace_all: source.replace_all === true,
    });
  };
  addReplacement(input);
  // MultiEdit (older versions): one replacement per sub-edit.
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) if (isObject(edit)) addReplacement(edit);
  }

  const patch = parsePatch(response.structuredPatch);
  const created =
    tool === 'Write' && response.type !== 'update' && (patch === undefined || patch.length === 0)
      ? (str(input.content) ?? str(response.content))
      : undefined;

  return {
    session_id,
    prompt_id: str(payload.prompt_id),
    transcript_path: str(payload.transcript_path),
    cwd: str(payload.cwd) ?? process.cwd(),
    tool,
    tool_use_id: str(payload.tool_use_id),
    agent_id: str(payload.agent_id),
    file_path,
    patch: patch && patch.length > 0 ? patch : undefined,
    created_content: created,
    replacements,
  };
}

/** A subagent's entries live beside the main transcript, not in it. */
export function subagentTranscriptPath(transcriptPath: string, sessionId: string, agentId: string): string {
  return path.join(path.dirname(transcriptPath), sessionId, 'subagents', `agent-${agentId}.jsonl`);
}

const TAIL_BYTES = 512 * 1024;

/**
 * The most recent model named near the end of a transcript, or undefined.
 *
 * When a PostToolUse hook runs, the assistant entry for the current tool call
 * is not on disk yet, so this looks at whichever is newer: the last assistant
 * entry (`message.model`) or the last request entry (`params.model`), which is
 * written before the response. The read is bounded to keep the hook fast.
 */
export function readModelFromTail(transcriptPath: string, maxBytes = TAIL_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split('\n');
    // The first line is cut off when the read started mid-file.
    const first = size > length ? 1 : 0;
    for (let i = lines.length - 1; i >= first; i--) {
      const line = lines[i];
      const isAssistant = line.includes('"type":"assistant"');
      const isRequest = !isAssistant && line.includes('"type":"api-request"');
      if (!isAssistant && !isRequest) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isObject(entry)) continue;
      let model: string | undefined;
      if (entry.type === 'assistant' && isObject(entry.message)) model = str(entry.message.model);
      else if (entry.type === 'api-request' && isObject(entry.params)) model = str(entry.params.model);
      // '<synthetic>' marks messages Claude Code wrote itself, not a model.
      if (model && model !== '<synthetic>') return model;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do.
      }
    }
  }
}

function modelAtHookTime(event: EditEvent): string | undefined {
  if (!event.transcript_path) return undefined;
  if (event.agent_id) {
    const own = subagentTranscriptPath(event.transcript_path, event.session_id, event.agent_id);
    const model = readModelFromTail(own);
    if (model) return model;
  }
  return readModelFromTail(event.transcript_path);
}

interface TranscriptModels {
  follower: JsonlFollower;
  /** tool_use id → the model of the assistant message that made the call. */
  byToolUse: Map<string, string>;
}

// One entry per transcript read so far. A live session's transcript grows
// constantly, so each lookup reads only what was appended since the last one.
const transcriptModels = new Map<string, TranscriptModels>();
const MAX_TRANSCRIPTS = 50;

function modelsIn(transcriptPath: string): Map<string, string> {
  let cached = transcriptModels.get(transcriptPath);
  if (!cached) {
    if (transcriptModels.size >= MAX_TRANSCRIPTS) {
      transcriptModels.delete(transcriptModels.keys().next().value!);
    }
    cached = { follower: new JsonlFollower(transcriptPath), byToolUse: new Map() };
    transcriptModels.set(transcriptPath, cached);
  }
  const { lines, reset } = cached.follower.read();
  if (reset) cached.byToolUse.clear();
  for (const line of lines) {
    // Skip the large majority of entries without parsing them.
    if (!line.includes('"tool_use"') || !line.includes('"assistant"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || entry.type !== 'assistant' || !isObject(entry.message)) continue;
    const model = str(entry.message.model);
    if (!model || model === '<synthetic>' || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (!isObject(block) || block.type !== 'tool_use') continue;
      const id = str(block.id);
      if (id) cached.byToolUse.set(id, model);
    }
  }
  return cached.byToolUse;
}

/**
 * The model of the assistant message that made this edit's tool call. This is
 * the reliable value: the hook runs before that message reaches the transcript,
 * so what it records is a guess.
 */
function modelForEdit(ref: EditRef): string | undefined {
  if (!ref.tool_use_id || !ref.transcript_path) return undefined;
  try {
    if (ref.agent_id) {
      const own = subagentTranscriptPath(ref.transcript_path, ref.session_id, ref.agent_id);
      const model = modelsIn(own).get(ref.tool_use_id);
      if (model) return model;
    }
    return modelsIn(ref.transcript_path).get(ref.tool_use_id);
  } catch {
    return undefined;
  }
}

const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  Read: 'read',
  NotebookRead: 'read',
  Grep: 'search',
  Glob: 'search',
  LS: 'search',
  ToolSearch: 'search',
  Bash: 'command',
  BashOutput: 'command',
  WebFetch: 'web',
  WebSearch: 'web',
  Agent: 'agent',
  Task: 'agent',
};

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

/** The one input field that says what a tool call was about. */
function toolDetail(input: Json): string {
  for (const key of ['file_path', 'path', 'pattern', 'command', 'url', 'query', 'description', 'prompt']) {
    const value = str(input[key]);
    if (value) return value.split('\n')[0].slice(0, 200);
  }
  return '';
}

/** A patch rebuilt from an Edit call's input, for calls whose result isn't in the transcript. Line numbers are unknown. */
function patchFromInput(input: Json): PatchHunk[] {
  const replacements = Array.isArray(input.edits) ? input.edits.filter(isObject) : [input];
  const hunks: PatchHunk[] = [];
  for (const r of replacements) {
    if (typeof r.new_string !== 'string') continue;
    const removed = typeof r.old_string === 'string' && r.old_string !== '' ? r.old_string.split('\n') : [];
    const added = r.new_string === '' ? [] : r.new_string.split('\n');
    hunks.push({
      oldStart: 0,
      oldLines: removed.length,
      newStart: 0,
      newLines: added.length,
      lines: [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)],
    });
  }
  return hunks;
}

/** The text of a user entry, or undefined when it carries tool results instead of a prompt. */
function promptText(content: unknown): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const texts: string[] = [];
  for (const block of content) {
    if (!isObject(block)) continue;
    if (block.type === 'tool_result') return undefined;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
  }
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Who submitted a user entry that holds text:
 * - 'human': typed by the user, or sent through the SDK;
 * - 'agent': submitted by Claude Code itself, e.g. when a background task finished;
 * - 'task': the task a subagent was given, which opens its transcript;
 * - undefined: a slash command or its output.
 */
function promptOrigin(entry: Json, text: string): 'human' | 'agent' | 'task' | undefined {
  const origin = isObject(entry.origin) ? str(entry.origin.kind) : undefined;
  const source = str(entry.promptSource);
  if (source === 'system' || (origin !== undefined && origin !== 'human') || SYNTHETIC_PROMPT.test(text)) return 'agent';
  if (origin === 'human' || source === 'typed' || source === 'sdk') return 'human';
  return entry.isSidechain === true ? 'task' : undefined;
}

/**
 * Reads a transcript as a thread: prompts, assistant text, tool calls, and
 * edits with their diffs. Thinking blocks, tool output, slash commands and
 * bookkeeping entries are left out.
 */
function readThread(transcriptPath: string): Thread | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(transcriptPath, 'utf8');
  } catch {
    return undefined;
  }
  const thread: Thread = { items: [] };
  const byToolUse = new Map<string, Extract<ThreadItem, { kind: 'tool' | 'edit' }>>();
  let n = 0;

  for (const line of raw.split('\n')) {
    if (line === '') continue;
    // Request logs and other bookkeeping make up most of the file.
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || !isObject(entry.message)) continue;
    const id = str(entry.uuid) ?? `entry-${n++}`;
    thread.session_id ??= str(entry.sessionId) ?? str(entry.session_id);
    thread.started ??= str(entry.timestamp);
    thread.branch = str(entry.gitBranch) ?? thread.branch;
    thread.version = str(entry.version) ?? thread.version;
    const content = entry.message.content;

    if (entry.type === 'assistant') {
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isObject(block)) continue;
        if (block.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') {
          thread.items.push({ kind: 'text', id, text: block.text });
        } else if (block.type === 'tool_use') {
          const callId = str(block.id);
          const name = str(block.name);
          const input = isObject(block.input) ? block.input : {};
          if (!callId || !name) continue;
          const file = str(input.file_path);
          let item: Extract<ThreadItem, { kind: 'tool' | 'edit' }>;
          if (EDIT_TOOLS.has(name) && file) {
            // Until the result is seen, show what the call asked for.
            const created = name === 'Write' ? (typeof input.content === 'string' ? input.content : '') : undefined;
            item = { kind: 'edit', id: callId, tool: name, file, patch: created === undefined ? patchFromInput(input) : [], created, failed: false };
          } else {
            item = { kind: 'tool', id: callId, category: TOOL_CATEGORIES[name] ?? 'other', name, detail: toolDetail(input), failed: false };
          }
          thread.items.push(item);
          byToolUse.set(callId, item);
        }
      }
      continue;
    }

    if (entry.type !== 'user' || entry.isMeta === true) continue;
    const text = promptText(content);
    if (text === undefined) {
      // Tool results: mark failures, and take an edit's real patch.
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_result') continue;
        const item = byToolUse.get(str(block.tool_use_id) ?? '');
        if (!item) continue;
        if (block.is_error === true) {
          item.failed = true;
          continue;
        }
        if (item.kind !== 'edit' || !isObject(entry.toolUseResult)) continue;
        const patch = parsePatch(entry.toolUseResult.structuredPatch);
        if (patch && patch.length > 0) {
          // A Write over an existing file: show what changed, not the whole file.
          item.patch = patch;
          item.created = undefined;
        }
      }
      continue;
    }

    const origin = promptOrigin(entry, text);
    const ts = str(entry.timestamp);
    // An agent-submitted prompt isn't the user's words, so its text is left out.
    // A subagent's task is shown: it is what the parent asked for.
    if (origin === 'agent') thread.items.push({ kind: 'prompt', id, text: '', origin: 'agent', ts });
    else if (origin === 'human') thread.items.push({ kind: 'prompt', id, text, origin: 'human', ts });
    else if (origin === 'task') thread.items.push({ kind: 'prompt', id, text, origin: 'agent', ts });
    // Anything else is a slash command or its output.
  }
  return thread;
}

/** Claude Code names a project's transcript folder after the session's cwd, with every other character turned into '-'. */
function projectFolder(dir: string): string {
  return dir.replace(/[^A-Za-z0-9]/g, '-');
}

function listDir(dir: string): string[] {
  try {
    return fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Transcripts of sessions whose cwd was the repo root or a folder below it.
 * The folder name is a lossy encoding, so a sibling such as `repo-old` matches
 * too; the caller drops edits to files outside the repo. A session started
 * above the repo is not found.
 */
function findTranscripts(repoRoot: string, env: NodeJS.ProcessEnv): TranscriptFile[] {
  const projects = path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  const prefix = projectFolder(path.resolve(repoRoot));
  const files: TranscriptFile[] = [];
  for (const folder of listDir(projects)) {
    if (folder !== prefix && !folder.startsWith(`${prefix}-`)) continue;
    const dir = path.join(projects, folder);
    for (const name of listDir(dir)) {
      if (!name.endsWith('.jsonl')) continue;
      const session_id = name.slice(0, -'.jsonl'.length);
      const main = path.join(dir, name);
      files.push({ path: main, session_id, main });
      for (const sub of listDir(path.join(dir, session_id, 'subagents'))) {
        const match = /^agent-(.+)\.jsonl$/.exec(sub);
        if (match) files.push({ path: path.join(dir, session_id, 'subagents', sub), session_id, agent_id: match[1], main });
      }
    }
  }
  return files;
}

/**
 * The prompts and applied edits in a transcript, for backfill. An edit is a
 * `tool_use` joined to its `tool_result`; the result's `toolUseResult` has the
 * shape of the hook's `tool_response`, so both go through `parseEditPayload`.
 * The session id is the file's, not the entries': one transcript was seen
 * whose entries named another session.
 */
function readTranscriptEvents(file: TranscriptFile): TranscriptEvents | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(file.path, 'utf8');
  } catch {
    return undefined;
  }
  const events: TranscriptEvents = { prompts: [], edits: [], skipped: 0 };
  const calls = new Map<string, { name: string; input: Json; model?: string }>();

  for (const line of raw.split('\n')) {
    if (!line.includes('"type":"user"') && !line.includes('"type":"assistant"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObject(entry) || !isObject(entry.message)) continue;
    const content = entry.message.content;

    if (entry.type === 'assistant') {
      if (!Array.isArray(content)) continue;
      const model = str(entry.message.model);
      for (const block of content) {
        if (!isObject(block) || block.type !== 'tool_use') continue;
        const id = str(block.id);
        const name = str(block.name);
        if (!id || !name || !EDIT_TOOLS.has(name) || !isObject(block.input)) continue;
        calls.set(id, { name, input: block.input, model: model === '<synthetic>' ? undefined : model });
      }
      continue;
    }

    if (entry.type !== 'user' || entry.isMeta === true) continue;
    const cwd = str(entry.cwd) ?? '';
    const text = promptText(content);
    if (text !== undefined) {
      const origin = promptOrigin(entry, text);
      if (origin !== 'human' && origin !== 'agent') continue;
      events.prompts.push({
        session_id: file.session_id,
        prompt_id: str(entry.promptId),
        transcript_path: file.main,
        cwd,
        prompt: text,
        human: origin === 'human',
        ts: str(entry.timestamp),
        entry_id: str(entry.uuid),
        branch: str(entry.gitBranch),
        version: str(entry.version),
      });
      continue;
    }

    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      const id = str(block.tool_use_id);
      const call = id ? calls.get(id) : undefined;
      if (!id || !call) continue;
      calls.delete(id);
      const ts = str(entry.timestamp);
      const event =
        block.is_error === true || !ts
          ? undefined
          : parseEditPayload({
              session_id: file.session_id,
              prompt_id: entry.promptId,
              transcript_path: file.main,
              cwd,
              tool_name: call.name,
              tool_input: call.input,
              tool_response: entry.toolUseResult,
              tool_use_id: id,
              agent_id: file.agent_id,
            });
      if (event && ts) events.edits.push({ ...event, ts, model: call.model });
      else events.skipped++;
    }
  }
  // Calls whose result never arrived: there is no telling whether they were applied.
  events.skipped += calls.size;
  return events;
}

/** CLAUDE_CODE_EXECPATH ends in the CLI version, e.g. `…/versions/2.1.325`. */
function version(env: NodeJS.ProcessEnv): string | undefined {
  const execPath = env.CLAUDE_CODE_EXECPATH;
  if (!execPath) return undefined;
  const last = path.basename(execPath);
  return /^\d+\.\d+\.\d+/.test(last) ? last : undefined;
}

export const claudeCode: AgentAdapter = {
  name: 'claude-code',
  parsePromptPayload,
  parseEditPayload,
  modelAtHookTime,
  modelForEdit,
  readThread,
  findTranscripts,
  readTranscriptEvents,
  subagentTranscriptPath,
  version,
};
