// Text for the end-of-line annotation and the hover card (docs/SPEC.md, "UX").
// Pure: no vscode import, so it is unit-tested directly. annotation.ts wraps
// the result in a MarkdownString.
//
// Everything that comes from a record or from git (prompt, author, summary) is
// untrusted and goes through escapeText. Command links are built only here,
// from the ids in HOVER_COMMANDS.
import type { Attribution, CommitInfo, Confidence, Edit, Turn } from '../store/schema';

/** The only commands a hover link may run. annotation.ts passes this list to `isTrusted.enabledCommands`. */
export const HOVER_COMMANDS = [
  'threadTrace.showThreadForLine',
  'threadTrace.copyPrompt',
  'threadTrace.openOnWeb',
  'threadTrace.openCommitDiff',
  'threadTrace.copySha',
  'threadTrace.hoverFilter',
] as const;
type HoverCommand = (typeof HOVER_COMMANDS)[number];

export type CardFilter = 'all' | 'threads' | 'commits';

export interface Card {
  markdown: string;
  enabledCommands: string[];
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** `claude-opus-5-5` → `Claude Opus 5.5`. Ids from other vendors are returned as they are. */
export function prettyModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const id = model.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '');
  if (!id.startsWith('claude-')) return model;
  const words: string[] = [];
  let lastWasNumber = false;
  for (const part of id.split('-')) {
    const isNumber = /^\d+$/.test(part);
    if (isNumber && lastWasNumber) words[words.length - 1] += `.${part}`;
    else words.push(isNumber ? part : part.charAt(0).toUpperCase() + part.slice(1));
    lastWasNumber = isNumber;
  }
  return words.join(' ');
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function relativeTime(time: number, now: number): string {
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE) return 'just now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m ago`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h ago`;
  if (elapsed < 2 * DAY) return 'Yesterday';
  if (elapsed < 30 * DAY) return `${Math.floor(elapsed / DAY)} days ago`;
  if (elapsed < 365 * DAY) return plural(Math.floor(elapsed / (30 * DAY)), 'month') + ' ago';
  return plural(Math.floor(elapsed / (365 * DAY)), 'year') + ' ago';
}

function dateGroup(time: number, now: number): string {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  if (time >= startOfToday) return 'Today';
  if (time >= startOfToday - 6 * DAY) return 'This week';
  return 'Older';
}

/** Makes untrusted text render literally: no Markdown, no HTML, no `$(icon)`, one line. */
export function escapeText(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/[\\`*_{}[\]()#+\-.!|~$:]/g, '\\$&');
}

function link(label: string, command: HoverCommand, args: unknown[], title: string): string {
  // Parentheses would end the Markdown link target early.
  const query = encodeURIComponent(JSON.stringify(args)).replace(/\(/g, '%28').replace(/\)/g, '%29');
  return `[${label}](command:${command}?${query} "${title}")`;
}

function threadCount(attribution: Attribution): number {
  const sessions = new Set<string>();
  if (attribution.edit) sessions.add(attribution.edit.session_id);
  for (const entry of attribution.history) if (entry.edit) sessions.add(entry.edit.session_id);
  return sessions.size;
}

/** The faded text after the cursor line. */
export function annotationText(attribution: Attribution, now: number): string {
  const { edit, commit, confidence } = attribution;
  const threads = threadCount(attribution);
  const suffix = threads > 0 ? ` · ${plural(threads, 'thread')}` : '';
  if (edit && (confidence === 'exact' || confidence === 'likely')) {
    const who = prettyModel(edit.model) ?? 'Agent';
    return `✦ ${who} · ${relativeTime(Date.parse(edit.ts), now)}${suffix}`;
  }
  if (!commit) return `Not committed yet${suffix}`;
  return `${commit.author}, ${relativeTime(commit.time * 1000, now)}${suffix}`;
}

type Entry =
  | { kind: 'thread'; time: number; edit: Edit; turn?: Turn; badge?: Confidence }
  | { kind: 'commit'; time: number; commit: CommitInfo }
  | { kind: 'uncommitted'; time: number };

const PROMPT_LINES = 2;
const PROMPT_LINE_LENGTH = 140;

function promptQuote(turn: Turn | undefined): string {
  if (!turn) return '> *No prompt was recorded for this edit.*';
  if (turn.origin === 'agent') return '> *Started by the agent itself, for example when a background task finished.*';
  const lines = turn.prompt
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (lines.length === 0) return '> *The prompt was not stored.*';
  const shown = lines.slice(0, PROMPT_LINES).map((line, index) => {
    const cut = line.length > PROMPT_LINE_LENGTH || (index === PROMPT_LINES - 1 && lines.length > PROMPT_LINES);
    return `> ${escapeText(line.slice(0, PROMPT_LINE_LENGTH))}${cut ? '…' : ''}`;
  });
  return shown.join('  \n');
}

function badge(confidence: Confidence): string {
  // `exact` is shown quietly; the grades that need a second look stand out.
  if (confidence === 'exact') return '$(check) exact';
  if (confidence === 'likely') return '**$(question) likely**';
  if (confidence === 'modified') return '**$(edit) modified**';
  return confidence;
}

function threadEntry(entry: Extract<Entry, { kind: 'thread' }>, now: number): string {
  const { edit, turn } = entry;
  const head = [
    `$(sparkle) **${escapeText(prettyModel(edit.model) ?? 'Unknown model')}**`,
    escapeText(turn?.agent.name ?? 'agent') + (edit.agent_id ? ' subagent' : ''),
    relativeTime(entry.time, now),
  ];
  if (entry.badge) head.push(badge(entry.badge));
  const actions = [link('Open thread', 'threadTrace.showThreadForLine', [edit.id], 'Open the conversation at this edit')];
  if (turn && turn.origin !== 'agent' && turn.prompt.trim() !== '') {
    actions.push(link('Copy prompt', 'threadTrace.copyPrompt', [turn.id], 'Copy the full prompt'));
  }
  if (turn?.thread_url?.startsWith('https://')) {
    actions.push(link('Open on claude.ai', 'threadTrace.openOnWeb', [turn.id], 'Open the thread in the browser'));
  }
  const parts = [];
  if (entry.badge === 'modified') parts.push('*Originally written by*');
  parts.push(head.join(' · '), promptQuote(turn), actions.join(' · '));
  return parts.join('\n\n');
}

function commitEntry(commit: CommitInfo, file: string | undefined, now: number): string {
  const short = commit.sha.slice(0, 7);
  const actions = [link('Copy SHA', 'threadTrace.copySha', [commit.sha], 'Copy the commit hash')];
  if (file) actions.unshift(link('Diff', 'threadTrace.openCommitDiff', [commit.sha, file], 'Show what this commit changed in the file'));
  return [
    `$(git-commit) **${escapeText(commit.summary || '(no message)')}**  `,
    `${escapeText(commit.author)} · ${relativeTime(commit.time * 1000, now)} · \`${short}\`  `,
    actions.join(' · '),
  ].join('\n');
}

export interface CardOptions {
  now: number;
  filter?: CardFilter;
  /** Repo-relative path of the file, for the commit Diff link. */
  file?: string;
}

/** The hover card: the line's threads and commits, newest first. */
export function renderCard(attribution: Attribution, options: CardOptions): Card {
  const { now, filter = 'all' } = options;
  const { edit, turn, commit, confidence } = attribution;

  const thread: Entry | undefined = edit ? { kind: 'thread', time: Date.parse(edit.ts), edit, turn, badge: confidence } : undefined;
  const landed: Entry = commit ? { kind: 'commit', time: commit.time * 1000, commit } : { kind: 'uncommitted', time: now };
  // What the line is now comes first: the thread and the commit it landed in,
  // or, for a line a human changed since, their commit and then the thread.
  const primary = (confidence === 'modified' ? [landed, thread] : [thread, landed]).filter((entry) => entry !== undefined);
  const primaryTime = Math.max(...primary.map((entry) => entry.time));
  const older: Entry[] = attribution.history
    .map((entry): Entry | undefined => {
      if (entry.edit) return { kind: 'thread', time: Date.parse(entry.edit.ts), edit: entry.edit, turn: entry.turn };
      if (entry.commit) return { kind: 'commit', time: entry.commit.time * 1000, commit: entry.commit };
      return undefined;
    })
    .filter((entry) => entry !== undefined)
    .sort((a, b) => b.time - a.time);

  const all = [...primary, ...older];
  const threads = threadCount(attribution);
  const commits = all.filter((entry) => entry.kind === 'commit').length;
  const shown = all.filter((entry) => filter === 'all' || (filter === 'threads' ? entry.kind === 'thread' : entry.kind !== 'thread'));

  const filters = [
    link('$(list-flat)', 'threadTrace.hoverFilter', ['all'], 'Show threads and commits'),
    link('$(comment-discussion)', 'threadTrace.hoverFilter', ['threads'], 'Show threads only'),
    link('$(git-commit)', 'threadTrace.hoverFilter', ['commits'], 'Show commits only'),
  ];
  const blocks = [`**Line ${attribution.line}** &nbsp;&nbsp; ${filters.join(' ')}`];

  let group: string | undefined;
  for (const entry of shown) {
    const label = dateGroup(primary.includes(entry) ? primaryTime : entry.time, now);
    if (label !== group) blocks.push(`*${label}*`);
    group = label;
    if (entry.kind === 'thread') blocks.push(threadEntry(entry, now));
    else if (entry.kind === 'commit') blocks.push(commitEntry(entry.commit, options.file, now));
    else blocks.push('$(circle-outline) Not committed yet');
  }
  if (shown.length === 0) blocks.push(filter === 'threads' ? '*No threads for this line.*' : '*No commits for this line.*');

  const totals = [];
  if (threads > 0) totals.push(plural(threads, 'thread'));
  if (commits > 0) totals.push(plural(commits, 'commit'));
  if (totals.length > 0) blocks.push('---', totals.join(' · '));

  return { markdown: blocks.join('\n\n'), enabledCommands: [...HOVER_COMMANDS] };
}
