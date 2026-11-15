// Per-agent interface (docs/SPEC.md, "Extension architecture"). Node-only:
// the hook bundle imports this, so it must never import vscode.
//
// M1 covers hook payloads, M2 the model lookup by tool call, M3 reading a
// transcript as a thread, M4 reading a transcript's prompts and edits for backfill.
import type { PatchHunk } from '../capture/lineRanges';

/** A prompt submission, normalized from an agent's hook payload. */
export interface PromptEvent {
  session_id: string;
  /** Identifies the turn. Absent on agent versions that don't send it. */
  prompt_id?: string;
  transcript_path?: string;
  cwd: string;
  prompt: string;
  /** False for prompts the agent generated itself (e.g. a background-task notification). */
  human: boolean;
}

/** One file edit, normalized from an agent's hook payload. */
export interface EditEvent {
  session_id: string;
  prompt_id?: string;
  transcript_path?: string;
  cwd: string;
  tool: string;
  tool_use_id?: string;
  /** Set when a subagent made the edit. */
  agent_id?: string;
  /** Absolute path of the edited file. */
  file_path: string;
  /** Post-edit patch from the tool result, when the agent provides one. */
  patch?: PatchHunk[];
  /** Set when the tool created the file; holds its full content. */
  created_content?: string;
  /** Raw replacements, used only when there is no patch. */
  replacements: { old_string: string; new_string: string; replace_all: boolean }[];
}

/** What it takes to find one edit's tool call in a transcript. */
export interface EditRef {
  session_id: string;
  tool_use_id?: string;
  agent_id?: string;
  /** The session's main transcript, from the edit's turn record. */
  transcript_path?: string;
}

export type ToolCategory = 'read' | 'search' | 'command' | 'web' | 'agent' | 'other';

/** One thing that happened in a thread, in transcript order. */
export type ThreadItem =
  | {
      kind: 'prompt';
      id: string;
      /** Empty for prompts the agent submitted itself, unless it is a subagent's task. */
      text: string;
      origin: 'human' | 'agent';
      ts?: string;
    }
  | { kind: 'text'; id: string; text: string }
  | {
      kind: 'tool';
      /** The tool call id. */
      id: string;
      category: ToolCategory;
      name: string;
      /** What it was called on: a path, a pattern, a command. */
      detail: string;
      failed: boolean;
    }
  | {
      kind: 'edit';
      /** The tool call id; edit records point at it with `tool_use_id`. */
      id: string;
      tool: string;
      /** Absolute path of the edited file. */
      file: string;
      /** From the tool result when there is one, otherwise rebuilt from the tool input. */
      patch: PatchHunk[];
      /** Set when the tool created the file; holds its full content. */
      created?: string;
      /** The call was rejected or failed, so nothing was written. */
      failed: boolean;
    };

/** A transcript, normalized for display. */
export interface Thread {
  items: ThreadItem[];
  session_id?: string;
  branch?: string;
  /** Agent version. */
  version?: string;
  /** ISO time of the first entry. */
  started?: string;
}

/** A transcript on this machine. */
export interface TranscriptFile {
  path: string;
  /** The session the file belongs to (a subagent's file belongs to its parent's session). */
  session_id: string;
  /** Set for a subagent's own transcript. */
  agent_id?: string;
  /** The session's main transcript; `path` itself unless this is a subagent's file. */
  main: string;
}

/** A prompt as it appears in a transcript. */
export interface TranscriptPrompt extends PromptEvent {
  /** ISO 8601. */
  ts?: string;
  /** Transcript entry uuid. */
  entry_id?: string;
  branch?: string;
  /** Agent version that wrote the entry. */
  version?: string;
}

/** An edit that was applied, joined from its tool call and its result. */
export interface TranscriptEdit extends EditEvent {
  /** ISO 8601 time of the result. */
  ts: string;
  /** The model of the message that made the call. */
  model?: string;
}

export interface TranscriptEvents {
  prompts: TranscriptPrompt[];
  edits: TranscriptEdit[];
  /** Edit calls left out: rejected, failed, or with no result or no time. */
  skipped: number;
}

export interface AgentAdapter {
  readonly name: string;
  parsePromptPayload(payload: unknown): PromptEvent | undefined;
  parseEditPayload(payload: unknown): EditEvent | undefined;
  /** Best-effort model for an edit at hook time. The read layer corrects it from the transcript. */
  modelAtHookTime(event: EditEvent): string | undefined;
  /**
   * The model that made this edit's tool call, read from the transcript, or
   * undefined when the transcript or the call is gone.
   */
  modelForEdit(ref: EditRef): string | undefined;
  /** Reads a transcript file as a thread, or undefined when it isn't on this machine. */
  readThread(transcriptPath: string): Thread | undefined;
  /**
   * Transcripts of sessions started in the repo at `repoRoot` or below it,
   * each session's main file before its subagents' files.
   */
  findTranscripts(repoRoot: string, env: NodeJS.ProcessEnv): TranscriptFile[];
  /** The prompts and applied edits in one transcript, in order. Undefined when it can't be read. */
  readTranscriptEvents(file: TranscriptFile): TranscriptEvents | undefined;
  /** Where a subagent's own transcript lives, given the session's main one. */
  subagentTranscriptPath(transcriptPath: string, sessionId: string, agentId: string): string;
  /** Agent version, from the hook's environment. */
  version(env: NodeJS.ProcessEnv): string | undefined;
}
