// What a whole file's attributions add up to: who owns each line (for the
// heatmap), the share of agent lines (for the status bar and its legend), and
// the threads that touched the file (for the Agent Threads view).
// Pure: no vscode import, so it is unit-tested directly.
//
// Prompts and model names come from records and commit messages, which are
// untrusted. Everything here is returned as plain text; the callers put it in
// tree items, quick picks and the status bar, none of which render Markdown.
import type { Attribution, Edit, Turn } from '../store/schema';
import { prettyModel, relativeTime } from './hoverCard';

/** How sure the heatmap is about a line: recorded, recorded but changed by hand since, or known only from the commit message. */
export type OwnerKind = 'agent' | 'modified' | 'commit';

export interface LineOwner {
  /** Model name as shown, e.g. `Claude Opus 5.5`. Lines are grouped and colored by it. */
  label: string;
  kind: OwnerKind;
}

const MAX_LABEL = 80;

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Who the heatmap credits a line to, or undefined for a line no agent is known to have written. */
export function ownerOf(attribution: Attribution): LineOwner | undefined {
  const { confidence, edit, commit } = attribution;
  if (confidence === 'commit') return { label: oneLine(commit?.trailers.coAuthor ?? 'Claude', MAX_LABEL), kind: 'commit' };
  if (!edit || confidence === 'none') return undefined;
  const label = oneLine(prettyModel(edit.model) ?? 'Unknown model', MAX_LABEL);
  return { label, kind: confidence === 'modified' ? 'modified' : 'agent' };
}

export interface OwnerGroup {
  label: string;
  /** Non-blank lines credited to this model, of every kind. */
  lines: number;
  /** Of those, lines a human changed after the agent wrote them. */
  modified: number;
  /** Of those, lines known only from a commit trailer. */
  commit: number;
}

export interface FileSummary {
  /** Non-blank lines in the file. */
  total: number;
  /** Non-blank lines an agent wrote, including ones changed by hand since. */
  agent: number;
  /** `agent` as a whole percentage of `total`. */
  percent: number;
  /** Largest first. */
  groups: OwnerGroup[];
}

/** `lines[i]` is the text of the line `attributions[i]` describes. Blank lines are not counted. */
export function summarize(attributions: Attribution[], lines: string[]): FileSummary {
  const groups = new Map<string, OwnerGroup>();
  let total = 0;
  let agent = 0;
  attributions.forEach((attribution, index) => {
    if ((lines[index] ?? '').trim() === '') return;
    total++;
    const owner = ownerOf(attribution);
    if (!owner) return;
    agent++;
    let group = groups.get(owner.label);
    if (!group) groups.set(owner.label, (group = { label: owner.label, lines: 0, modified: 0, commit: 0 }));
    group.lines++;
    if (owner.kind === 'modified') group.modified++;
    if (owner.kind === 'commit') group.commit++;
  });
  return {
    total,
    agent,
    percent: total === 0 ? 0 : Math.round((agent / total) * 100),
    groups: [...groups.values()].sort((a, b) => b.lines - a.lines || a.label.localeCompare(b.label)),
  };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** The status bar text, e.g. `✦ 62% agent`. */
export function statusText(summary: FileSummary): string {
  // A file with a few agent lines shouldn't round down to "0%".
  const percent = summary.agent > 0 && summary.percent === 0 ? '<1' : String(summary.percent);
  return `✦ ${percent}% agent`;
}

export interface LegendRow {
  /** The model, or undefined for the row of lines no agent wrote. */
  owner?: string;
  label: string;
  description: string;
}

/** The legend behind the status bar item: one row per model, then the rest of the file. */
export function legendRows(summary: FileSummary): LegendRow[] {
  const rows: LegendRow[] = summary.groups.map((group) => {
    const notes = [];
    if (group.modified > 0) notes.push(`${group.modified} edited by hand since`);
    if (group.commit > 0) notes.push(`${group.commit} from commit messages only`);
    return {
      owner: group.label,
      label: group.label,
      description: plural(group.lines, 'line') + (notes.length > 0 ? ` (${notes.join(', ')})` : ''),
    };
  });
  rows.push({ label: 'No agent recorded', description: plural(summary.total - summary.agent, 'line') });
  return rows;
}

/** Hands out color slots to models in the order they are first seen, so a model keeps its color across files. */
export class ColorSlots {
  private readonly slots = new Map<string, number>();

  constructor(private readonly size: number) {}

  of(label: string): number {
    let slot = this.slots.get(label);
    if (slot === undefined) this.slots.set(label, (slot = this.slots.size % this.size));
    return slot;
  }
}

export interface ThreadEditRow {
  edit: Edit;
  label: string;
  description: string;
}

export interface FileThread {
  session_id: string;
  /** The session's newest edit to the file: where the panel opens. */
  newest: Edit;
  turn?: Turn;
  label: string;
  description: string;
  tooltip: string;
  /** Newest first. */
  edits: ThreadEditRow[];
}

const MAX_TITLE = 80;
const MAX_TOOLTIP = 600;

function editLabel(edit: Edit): string {
  const lines = edit.hunks.reduce((sum, hunk) => sum + (hunk.hashes?.length ?? 0), 0);
  const placed = edit.hunks.filter((hunk) => hunk.start !== undefined);
  if (placed.length === 0) return `${oneLine(edit.tool, 20)} · ${plural(lines, 'line')}`;
  const from = Math.min(...placed.map((hunk) => hunk.start!));
  const to = Math.max(...placed.map((hunk) => hunk.end ?? hunk.start!));
  return `${oneLine(edit.tool, 20)} · ${from === to ? `line ${from}` : `lines ${from}–${to}`}`;
}

/**
 * The threads that edited a file, newest first, each with its edits. `edits`
 * may hold the same edit twice (a file's records under two names); it is
 * counted once.
 */
export function fileThreads(edits: Edit[], turnOf: (id: string) => Turn | undefined, now: number): FileThread[] {
  const sessions = new Map<string, Edit[]>();
  const seen = new Set<string>();
  for (const edit of edits) {
    if (seen.has(edit.id)) continue;
    seen.add(edit.id);
    const list = sessions.get(edit.session_id);
    if (list) list.push(edit);
    else sessions.set(edit.session_id, [edit]);
  }
  const threads: FileThread[] = [];
  for (const [session_id, list] of sessions) {
    list.sort((a, b) => (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0));
    const newest = list[0];
    // The session's first prompt that led to an edit here names the thread.
    const prompted = [...list]
      .reverse()
      .map((edit) => turnOf(edit.turn_id))
      .find((turn) => turn && turn.origin !== 'agent' && turn.prompt.trim() !== '');
    const prompt = prompted?.prompt.trim() ?? '';
    const firstLine = prompt.split('\n', 1)[0] ?? '';
    const description = [plural(list.length, 'edit'), prettyModel(newest.model), relativeTime(Date.parse(newest.ts), now)]
      .filter((part) => part)
      .map((part) => oneLine(part!, MAX_LABEL))
      .join(' · ');
    threads.push({
      session_id,
      newest,
      turn: prompted ?? turnOf(newest.turn_id),
      label: firstLine ? oneLine(firstLine, MAX_TITLE) : `Session ${session_id.slice(0, 8)}`,
      description,
      tooltip: prompt ? (prompt.length > MAX_TOOLTIP ? `${prompt.slice(0, MAX_TOOLTIP)}…` : prompt) : 'No prompt was recorded for this thread.',
      edits: list.map((edit) => ({ edit, label: editLabel(edit), description: relativeTime(Date.parse(edit.ts), now) })),
    });
  }
  return threads.sort((a, b) => (a.newest.ts < b.newest.ts ? 1 : a.newest.ts > b.newest.ts ? -1 : 0));
}
