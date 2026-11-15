// HTML for the thread panel (docs/SPEC.md, "Thread panel"). Pure: no vscode
// import, so it is unit-tested directly. threadPanel.ts puts it in a webview.
//
// Transcript content is untrusted: it can hold HTML, file contents and
// prompt-injection text. Every value goes through escapeHtml, nothing is
// rendered as Markdown, and the page's CSP allows only the panel's own
// stylesheet and one script, by nonce.
import * as path from 'node:path';
import type { PatchHunk } from '../capture/lineRanges';
import type { Thread, ThreadItem, ToolCategory } from '../adapters/types';
import type { Edit, Turn } from '../store/schema';
import { prettyModel } from './hoverCard';

export interface ThreadView {
  /** The records behind the hovered line. */
  turn?: Turn;
  edit?: Edit;
  /** The session's transcript, or undefined when it isn't on this machine. */
  thread?: Thread;
  /** The subagent's own transcript, when a subagent made the edit. */
  subagent?: Thread;
  /** The tool call to scroll to and highlight. */
  target?: string;
  /** Repo root, to show file paths relative to it. */
  root?: string;
  /** True when the transcript file exists, so it can be revealed. */
  hasTranscript?: boolean;
}

export interface WebviewResources {
  cspSource: string;
  nonce: string;
  styleUri: string;
  scriptUri: string;
}

const TITLE_LENGTH = 60;
const TEXT_LIMIT = 8000;
const DIFF_LINE_LIMIT = 400;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function firstPrompt(view: ThreadView): string {
  for (const item of view.thread?.items ?? []) {
    if (item.kind === 'prompt' && item.origin === 'human' && item.text.trim() !== '') return item.text;
  }
  return view.turn?.prompt ?? '';
}

/** The panel title: the session's first prompt, on one line. */
export function threadTitle(view: ThreadView): string {
  const line = firstPrompt(view).trim().split('\n')[0]?.trim() ?? '';
  if (line === '') return 'Agent thread';
  return line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH)}…` : line;
}

function clip(text: string): string {
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}\n… (${text.length - TEXT_LIMIT} more characters)` : text;
}

function displayPath(file: string, root: string | undefined): string {
  if (!root) return file;
  const relative = path.relative(root, file);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative) ? relative.split(path.sep).join('/') : file;
}

function localTime(iso: string | undefined): string | undefined {
  const time = iso ? new Date(iso) : undefined;
  if (!time || Number.isNaN(time.getTime())) return undefined;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${time.getFullYear()}-${pad(time.getMonth() + 1)}-${pad(time.getDate())} ${pad(time.getHours())}:${pad(time.getMinutes())}`;
}

const TOOL_PHRASES: Record<ToolCategory, [verb: string, one: string, many: string]> = {
  read: ['read', 'file', 'files'],
  search: ['ran', 'search', 'searches'],
  command: ['ran', 'command', 'commands'],
  web: ['fetched', 'web page', 'web pages'],
  agent: ['started', 'subagent', 'subagents'],
  other: ['used', 'other tool', 'other tools'],
};

/** `Ran 3 searches, read 13 files` for a run of tool calls. */
export function toolSummary(tools: { category: ToolCategory }[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const tool of tools) counts.set(tool.category, (counts.get(tool.category) ?? 0) + 1);
  const parts: string[] = [];
  for (const [category, count] of counts) {
    const [verb, one, many] = TOOL_PHRASES[category];
    parts.push(`${verb} ${count} ${count === 1 ? one : many}`);
  }
  const text = parts.join(', ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function diffLines(patch: PatchHunk[], created: string | undefined): { cls: string; text: string }[] {
  if (created !== undefined) {
    const lines = created.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines.map((text) => ({ cls: 'add', text: `+${text}` }));
  }
  const lines: { cls: string; text: string }[] = [];
  for (const hunk of patch) {
    if (hunk.newStart > 0) lines.push({ cls: 'hunk', text: `@@ line ${hunk.newStart} @@` });
    else if (lines.length > 0) lines.push({ cls: 'hunk', text: '@@' });
    for (const text of hunk.lines) {
      const marker = text[0];
      lines.push({ cls: marker === '+' ? 'add' : marker === '-' ? 'del' : marker === '\\' ? 'hunk' : 'ctx', text });
    }
  }
  return lines;
}

function editHtml(item: Extract<ThreadItem, { kind: 'edit' }>, view: ThreadView): string {
  const lines = diffLines(item.patch, item.created);
  const shown = lines.slice(0, DIFF_LINE_LIMIT);
  const rows = shown.map((line) => `<span class="${line.cls}">${escapeHtml(line.text)}</span>`);
  if (lines.length > shown.length) rows.push(`<span class="hunk">… ${lines.length - shown.length} more lines</span>`);
  const verb = item.created !== undefined ? 'Created' : item.tool === 'Write' ? 'Rewrote' : 'Edited';
  const status = item.failed ? '<span class="failed">not applied</span>' : '';
  const target = item.id === view.target ? ' target' : '';
  return [
    `<article class="edit${target}" data-tool="${escapeHtml(item.id)}">`,
    `<header><span class="verb">${verb}</span> <span class="file">${escapeHtml(displayPath(item.file, view.root))}</span>${status}</header>`,
    rows.length > 0 ? `<pre class="diff">${rows.join('\n')}</pre>` : '',
    '</article>',
  ].join('');
}

function toolsHtml(tools: Extract<ThreadItem, { kind: 'tool' }>[], view: ThreadView): string {
  const rows = tools.map((tool) => {
    const detail = tool.detail ? ` <span class="detail">${escapeHtml(displayPath(tool.detail, view.root))}</span>` : '';
    const failed = tool.failed ? ' <span class="failed">failed</span>' : '';
    return `<li data-tool="${escapeHtml(tool.id)}"><span class="name">${escapeHtml(tool.name)}</span>${detail}${failed}</li>`;
  });
  return `<details class="tools"><summary>${escapeHtml(toolSummary(tools))}</summary><ul>${rows.join('')}</ul></details>`;
}

function itemsHtml(items: ThreadItem[], view: ThreadView): string {
  const blocks: string[] = [];
  let tools: Extract<ThreadItem, { kind: 'tool' }>[] = [];
  const flush = () => {
    if (tools.length > 0) blocks.push(toolsHtml(tools, view));
    tools = [];
  };
  for (const item of items) {
    if (item.kind === 'tool') {
      tools.push(item);
      continue;
    }
    flush();
    if (item.kind === 'prompt') {
      const human = item.origin === 'human';
      const label = human ? 'You' : item.text === '' ? 'Agent' : 'Task from the main agent';
      const body = item.text === '' ? '<p class="note">The agent continued on its own, for example when a background task finished.</p>' : `<pre class="text">${escapeHtml(clip(item.text))}</pre>`;
      const time = localTime(item.ts);
      blocks.push(
        `<section class="prompt${human ? '' : ' agent'}"><h2>${label}${time ? ` <time>${escapeHtml(time)}</time>` : ''}</h2>${body}</section>`,
      );
    } else if (item.kind === 'text') {
      blocks.push(`<pre class="text assistant">${escapeHtml(clip(item.text))}</pre>`);
    } else {
      blocks.push(editHtml(item, view));
    }
  }
  flush();
  return blocks.join('\n');
}

/** Shown when the transcript isn't on this machine: what the records alone say. */
function recordHtml(view: ThreadView): string {
  const { turn, edit } = view;
  const rows: string[] = ['<p class="note">The transcript for this session isn’t on this machine, so only the recorded turn is shown.</p>'];
  if (turn && turn.origin !== 'agent' && turn.prompt !== '') {
    rows.push(`<section class="prompt"><h2>You</h2><pre class="text">${escapeHtml(clip(turn.prompt))}</pre></section>`);
  } else {
    rows.push('<p class="note">No prompt was recorded for this edit.</p>');
  }
  if (edit) {
    const lines = edit.hunks.reduce((sum, hunk) => sum + hunk.hashes.length, 0);
    const target = edit.tool_use_id && edit.tool_use_id === view.target ? ' target' : '';
    rows.push(
      `<article class="edit${target}"${edit.tool_use_id ? ` data-tool="${escapeHtml(edit.tool_use_id)}"` : ''}>` +
        `<header><span class="verb">${escapeHtml(edit.tool)}</span> <span class="file">${escapeHtml(edit.file)}</span></header>` +
        `<p class="note">${lines} ${lines === 1 ? 'line' : 'lines'} written. The diff is only in the transcript.</p></article>`,
    );
  }
  return rows.join('\n');
}

function hasTarget(view: ThreadView): boolean {
  const all = [...(view.thread?.items ?? []), ...(view.subagent?.items ?? [])];
  return all.some((item) => (item.kind === 'edit' || item.kind === 'tool') && item.id === view.target);
}

export function renderThreadHtml(view: ThreadView, resources: WebviewResources): string {
  const { turn, edit, thread } = view;
  const meta = [
    turn?.agent.name ? `${turn.agent.name}${(turn.agent.version ?? thread?.version) ? ` ${turn.agent.version ?? thread?.version}` : ''}` : undefined,
    prettyModel(edit?.model),
    turn?.session_id ?? edit?.session_id ?? thread?.session_id,
    localTime(turn?.ts ?? thread?.started),
    turn?.git.branch ?? thread?.branch,
  ].filter((value): value is string => !!value);

  const buttons: string[] = [];
  if (turn?.thread_url?.startsWith('https://')) buttons.push('<button data-action="openWeb">Open on claude.ai</button>');
  if (view.hasTranscript) buttons.push('<button data-action="revealTranscript">Reveal transcript file</button>');
  if (firstPrompt(view) !== '') buttons.push('<button data-action="copyPrompt">Copy prompt</button>');

  const body: string[] = [];
  if (!thread) {
    body.push(recordHtml(view));
  } else {
    if (view.target && !hasTarget(view)) {
      body.push('<p class="note warning">The tool call that wrote this line isn’t in the transcript any more.</p>');
    }
    body.push(itemsHtml(thread.items, view));
    if (view.subagent) {
      body.push('<h2 class="divider">Subagent</h2>', itemsHtml(view.subagent.items, view));
    }
  }

  const csp = `default-src 'none'; style-src ${resources.cspSource}; script-src 'nonce-${resources.nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${escapeHtml(resources.styleUri)}">
<title>${escapeHtml(threadTitle(view))}</title>
</head>
<body data-target="${escapeHtml(view.target ?? '')}">
<header class="thread">
<h1>${escapeHtml(threadTitle(view))}</h1>
<p class="meta">${meta.map(escapeHtml).join(' · ')}</p>
<p class="actions">${buttons.join(' ')}</p>
</header>
<main>
${body.join('\n')}
</main>
<script nonce="${escapeHtml(resources.nonce)}" src="${escapeHtml(resources.scriptUri)}"></script>
</body>
</html>`;
}
