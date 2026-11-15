// Claude Code adapter. All knowledge of Claude Code's hook payloads and
// transcript format lives in this file; both are internals, not a stable API.
// Field names were checked against real payloads from CLI 2.1.325
// (test/fixtures/hook-payloads, docs/SPEC.md "Hook payloads observed").
//
// Node-only: the hook bundle imports this, so it must never import vscode.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PatchHunk } from '../capture/lineRanges';
import type { AgentAdapter, EditEvent, PromptEvent } from './types';

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
  version,
};
