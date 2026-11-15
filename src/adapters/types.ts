// Per-agent interface (docs/SPEC.md, "Extension architecture"). Node-only:
// the hook bundle imports this, so it must never import vscode.
//
// M1 covers hook payloads. Transcript parsing and thread rendering are added
// in M3 and M4.
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

export interface AgentAdapter {
  readonly name: string;
  parsePromptPayload(payload: unknown): PromptEvent | undefined;
  parseEditPayload(payload: unknown): EditEvent | undefined;
  /** Best-effort model for an edit at hook time. The read layer corrects it from the transcript. */
  modelAtHookTime(event: EditEvent): string | undefined;
  /** Agent version, from the hook's environment. */
  version(env: NodeJS.ProcessEnv): string | undefined;
}
