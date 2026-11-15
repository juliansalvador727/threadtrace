# Thread Trace — VS Code Extension Spec

Nov 15, 2026 · @Julian

## Overview

**Thread Trace** is a VS Code extension that tells you who wrote a line of code and why. Hover a line to see which agent and model wrote it, the prompt behind the edit, and the commit it landed in. One click opens the full thread, scrolled to the tool call that wrote that line.

The reference UX is Zed's agent blame (see the attached video). The current line ends in a faint annotation such as `Danilo Leal, Yesterday · 1 thread`. Hovering it opens a **Line 3141** card that lists the line's history, with threads and commits mixed together. Clicking a thread opens the conversation at the patch that touched that line.

**Why this needs two halves.** `git blame` only knows who *committed* a line. It doesn't know which agent, model or prompt produced it, and that information isn't in the file. So the extension needs:

1. **A capture layer** that records each agent edit when it happens: prompt, model, session, file and line hashes.
2. **A read layer** inside VS Code that maps any line (committed or not) back to one of those records, says how confident the match is, and renders the result.

The capture layer is the harder half and the one most specs skip. If it's done well, the UI is ordinary VS Code API work.

## Goals and non-goals (v1)

**Goals**

- Line-level attribution for **Claude Code** edits made on this machine: agent, model, prompt, session, timestamp and commit.
- A Zed-style **hover card** on the current line's blame annotation.
- A **thread panel** that opens the transcript scrolled to the tool call that wrote the line.
- **Backfill** from Claude Code transcripts already on disk, so code written before install is also attributed.
- **Commit-level fallback** from commit trailers (`Claude-Session:`, `Co-Authored-By:`). This covers work from cloud sessions, which don't run local hooks.
- **Honest confidence.** Every attribution is labeled `exact`, `likely`, `modified`, `commit` or `none`; nothing is guessed silently.
- Local and offline. Nothing leaves the machine.

**Non-goals (v1)**

- Team sync or a hosted server. Records are per-machine; sharing them is an explicit export.
- Agents other than Claude Code. v1 ships the adapter interface; Codex, Cursor and others come in v2.
- Attributing code pasted from a chat window.
- Precise attribution after heavy human rewrites. The extension reports `modified` or `none` in those cases instead.

## Beyond Zed

Zed answers *which thread wrote this line* and opens it. That's where Thread Trace starts, not where it stops. Zed has three gaps:

- **The prompt is often a weak answer to “why”.** The turn that wrote a line is frequently just “yes, do it”.
- **It only knows about Zed's own agent.**
- **It's read-only and for humans only.** Nothing feeds back into the next agent run.

The features below close those gaps. They're grouped by the question each one answers.

### 1. Why does this line exist? (better than the raw prompt)

- **Intent + trigger.** The card shows two prompts:
  - **Intent:** the first substantive prompt in the chain that led to the edit, found by walking back past short confirmations such as “ok”, “yes” and “go ahead”.
  - **Trigger:** the prompt that immediately caused the edit.

  Zed shows only one prompt, which is often “yes”.
- **Rationale snippet.** Under the prompts, the card shows the assistant text written just before the `tool_use` that wrote the line, which is usually where the agent explains its plan. Cap it at about 3 lines; the full text is in the thread.
- **Alternatives considered.** If the thread discussed options (“should it mirror the existing action, or expand all?”), the card shows the question and the option chosen. Detect this with simple heuristics (a question in an assistant turn, then a user reply, then edits) and an optional LLM pass.
- **Ask why.** An inline **Ask** box answers questions about the line, such as “why not use the existing helper?”, from the thread's transcript. It runs through the user's own Claude Code CLI in headless mode (`claude -p`, with the transcript slice as context), so there's no API key to manage. The answer cites the transcript entries it drew on, and you can click them.

### 2. Can I trust this line? (verification provenance)

- **Verified badge.** After an edit, scan the rest of the turn for test, build or lint commands the agent ran (`Bash` tool calls that match `test`, `pytest`, `cargo`, `npm run`, `tsc` and similar) and read their exit status. The card then shows one of:
  - `✓ tests passed after this edit`
  - `✗ tests failed, agent continued`
  - `⚠ never verified`
- **Unreviewed agent code.** This is a heatmap mode, alongside the attribution heatmap. It highlights agent lines that no human has changed and that haven't been seen in a diff since they landed. Count a line as seen when its hunk was visible in VS Code's diff or SCM view, or when it was in a PR you approved (v2, using the GitHub API). It points review effort where it's needed.
- **Drift warning.** Flag a line when a later turn in the same or another thread explicitly reversed the decision behind it (for example, “actually, don't cache this”) but the line survived. This is a common source of leftover agent code.

### 3. Where did this come from, across agents and time? (navigation)

- **Every agent, one view.** Zed only sees its own agent. Thread Trace merges Claude Code (local and cloud), other agents through adapters, and human commits into one timeline.
- **Range and function attribution.** Select a range or put the cursor in a function, and a CodeLens shows `14 lines · 3 threads · 2 models · you edited 4`. Clicking it opens a breakdown, line by line and thread by thread.
- **Reverse search.** **Thread Trace: Find Code by Prompt** takes a query (“auth”, “retry logic”), searches prompts and rationales, and lists the lines in the workspace that came from those turns and still exist. It's code search by intent.
- **Session replay.** Step through every edit one thread made to a file, in order, in VS Code's diff editor, with the prompt for each step shown above the diff. Zed jumps to one patch; replay shows how the code got there.
- **Stack trace to thread.** Paste a stack trace or an error with file:line frames. Each frame resolves to its thread, giving “this crash goes through code from session X, prompt Y”. This covers a common request: linking production errors back to the session that wrote the code.

### 4. What do I do about it? (actions)

- **Revert this turn.** Builds the inverse patch of every edit from one turn or thread that is still in the tree, and opens it as a diff for you to apply. It never applies automatically.
- **Continue this thread.** Resumes the session in Claude Code (`claude --resume <session_id>`) in a terminal, with the file and line already in context. It's the fastest way to say “you wrote this, now fix it”.
- **PR provenance summary.** Generates a Markdown block for the PR description: the share of agent-written lines, the threads involved with links, the intent prompts, and verification status. Reviewers get the context without asking.

### 5. Let agents use it too

This is the biggest step past Zed, and it's what the original pitch was about: agents tracing code back to the threads that produced it.

- **Local MCP server.** Ship `tt-mcp.js`, a stdio MCP server bundled with the extension, with these tools:
  - `why(file, line | range)` returns the attribution, intent, rationale and verification status.
  - `threads_for(file)` lists the threads that touched a file.
  - `search_intent(query)` is reverse search.
  - `decisions(file)` returns the extracted decisions and the alternatives that were rejected.
- **Registration.** Register it with Claude Code (`claude mcp add`) from the install command, and with VS Code's MCP server definition API so agent mode in VS Code can call it too.
- **Skill / CLAUDE.md snippet.** A short instruction: “before changing code you didn't write in this session, call `why` on it.” Agents then stop undoing earlier decisions they couldn't see, which is the most common way agent code regresses.
- **Write-back.** When an agent reads a `why` result and then changes the line, the new edit record links to the earlier one (`supersedes: edit_id`). That builds a decision chain per line.

### 6. Which models write code that lasts? (insights)

You asked which of your models and agents wrote each line, so the extension should also compare them over time.

- **Survival.** For each model and agent: the percentage of lines still present after 7, 30 and 90 days, and the median time until a human first edits them.
- **Churn hotspots.** Files where agent lines are rewritten most often, a sign that the agent keeps misreading that code.
- **Verification rate** by model: how often its edits were followed by a passing test.
- These show in a **Thread Trace: Insights** webview, computed locally from the store plus `git log`. They're never uploaded.

### Schema additions

```ts
interface Edit {
  // … existing fields
  rationale?: string;          // assistant text preceding the tool_use, trimmed
  intent_turn_id?: string;     // first substantive prompt in the chain
  verification?: { status: 'passed' | 'failed' | 'none'; command?: string; tool_use_id?: string };
  supersedes?: string[];       // edit ids this edit consciously replaced (via MCP why)
}
interface Decision {
  id: string; session_id: string; question: string; chosen: string;
  rejected: string[]; entry_ids: string[]; files: string[];
}
```

Compute these at capture time where possible; the hook can read the turn's transcript tail. Verification status can only be known later, so a `Stop` hook updates it when the turn finishes.

### Phasing

| Phase | Features |
| --- | --- |
| v1.1 (right after M5) | Intent + trigger, rationale snippet, verified badge, Continue this thread |
| v1.2 | MCP server + skill, reverse search, range CodeLens |
| v1.3 | Session replay, revert turn, PR summary, stack trace to thread |
| v2 | Ask why, decisions, drift warning, unreviewed heatmap, insights dashboard |

If you only build one thing from this list, build the **MCP `why` tool**. It turns Thread Trace from a viewer for humans into memory for your agents, and nothing comparable exists in Zed.

## Capture: where attribution comes from

There are three sources. They are listed from most to least precise, and the resolver tries them in this order.

### 1. Agent hooks (primary, line-level)

Claude Code runs user-defined hooks at lifecycle events and passes each hook a JSON payload on stdin. The payload includes `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input` and `tool_response`. We register two hooks:

- **`UserPromptSubmit`** records the prompt and starts a new *turn* for the session.
- **`PostToolUse`** with matcher `Edit|Write|MultiEdit` records the edit and attaches it to the session's current turn.

The extension bundles a small Node script, `tt-capture.js`, and copies it to `~/.thread-trace/bin/`. The command **Thread Trace: Install Agent Hooks** shows a diff and asks for confirmation, then merges the following into `.claude/settings.json` (project scope) or `~/.claude/settings.json` (user scope):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node ~/.thread-trace/bin/tt-capture.js prompt" }] }
    ],
    "PostToolUse": [
      { "matcher": "Edit|Write|MultiEdit",
        "hooks": [{ "type": "command", "command": "node ~/.thread-trace/bin/tt-capture.js edit" }] }
    ]
  }
}
```

What `tt-capture edit` does:

1. Parses stdin, finds the repo root (walk up from `cwd` looking for `.git`), and reads HEAD straight from `.git/HEAD`. It never spawns git, so the hook stays fast.
2. Computes the line ranges the edit wrote:
   - `Write`: the whole file.
   - `Edit`: reads the file after the edit and finds every occurrence of `new_string` (all of them when `replace_all` is set).
   - `MultiEdit`: does the same for each sub-edit.
3. Hashes each written line (see the data model) and keeps the hashes of `old_string` too, as `removed_hashes`.
4. Gets the **model**. It isn't in the hook payload, so the script reads the last assistant entry in `transcript_path` (its `message.model` field).
5. Appends one JSON line to `.git/thread-trace/edits.jsonl`.

Hook rules:

- Always exit 0, even on internal errors. A tracing bug must never block the agent.
- Stay under 50 ms.
- Append only, with no read-modify-write.
- Log failures to `~/.thread-trace/capture.log`.

### 2. Transcript backfill (secondary, line-level)

Claude Code stores each session as a JSONL transcript under `~/.claude/projects/<encoded-project-path>/`. The command **Thread Trace: Backfill from Transcripts** scans the transcripts for the current repo and pairs each user prompt with the `Edit`/`Write` tool calls that followed it. It emits the same records as the hooks, tagged `source: "backfill"`.

Backfill doesn't know where the lines landed at the time. That's fine: resolution is hash-based, so the record only needs the hashes of the lines in `new_string`.

### 3. Commit trailers (fallback, commit-level)

The extension parses agent trailers in commit messages, for example:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_…
```

A trailer gives the agent, the model and a link to the thread. It doesn't give the prompt or line precision. Commits from cloud sessions carry these trailers, so this source covers sessions whose transcripts aren't on this machine.

### Interop and stability

- **Agent Trace.** Agent Trace is an emerging open spec for AI code attribution. It stores records as a JSONL sidecar at `.agent-trace/traces.jsonl`. v1 keeps its own format, which is a superset of the fields Agent Trace records, and provides **Export to Agent Trace**. Check the current schema before building the exporter.
- **Internal formats.** The hook payload and the transcript format are Claude Code internals, not a stable public API. Keep all knowledge of them in `adapters/claudeCode.ts` and record the agent version on every record. Before building, check field names against the current Claude Code hooks docs.

## Data model

**Storage:** each repo gets `.git/thread-trace/turns.jsonl` and `.git/thread-trace/edits.jsonl`. Because they live inside `.git/`, they are never committed by accident. Both files are append-only JSONL. The extension loads them into an in-memory index and follows new lines as they're written.

```ts
interface Turn {
  v: 1;
  id: string;              // `${session_id}:${turnIndex}`
  agent: { name: 'claude-code' | string; version?: string };
  session_id: string;
  thread_url?: string;     // e.g. https://claude.ai/code/session_… when known
  transcript_path?: string;
  prompt_entry_id?: string; // transcript entry uuid, for jump-to
  prompt: string;          // full | first line | '' per settings, after redaction
  ts: string;              // ISO 8601
  cwd: string;
  git: { head: string; branch?: string };
  source: 'hook' | 'backfill';
}

interface Edit {
  v: 1;
  id: string;              // ulid
  turn_id: string;
  session_id: string;
  tool_use_id?: string;    // jump target inside the transcript
  tool: 'Edit' | 'Write' | 'MultiEdit' | string;
  model?: string;          // e.g. 'claude-opus-5-5'
  file: string;            // repo-relative, POSIX separators
  ts: string;
  hunks: { start?: number; end?: number; hashes: string[] }[]; // 1-based, post-edit; positions absent for backfill
  removed_hashes?: string[];
  base_head: string;
  source: 'hook' | 'backfill';
}

type Confidence = 'exact' | 'likely' | 'modified' | 'commit' | 'none';

interface Attribution {
  line: number;
  confidence: Confidence;
  edit?: Edit; turn?: Turn;
  commit?: { sha: string; author: string; time: number; summary: string;
             trailers: { session?: string; coAuthor?: string } };
  history: Attribution[];  // older threads/commits for this line, newest first
}
```

**Line hashing.**

- Normalize the line: convert CRLF to LF and strip trailing whitespace.
- Take the first 12 hex characters of its SHA-1 as the **strict** hash.
- Also store a **loose** hash with all whitespace collapsed. It survives formatter re-indents.

**Weak lines.** Lines that are blank or very common (`}`, `{`, `);`, `end`, `else {` and similar, via a per-language list plus a frequency check) are marked weak. A weak line never matches on its own; it inherits attribution from the nearest strong line in the same hunk. Without this rule, every closing brace in the repo would claim to be written by the same session.

## Extension architecture

| Component | Responsibility |
| --- | --- |
| `TraceStore` | Loads `turns.jsonl` and `edits.jsonl`, follows them with `fs.watch`, and indexes edits as `Map<file, Map<hash, Edit[]>>`. |
| `GitService` | Gets the repo through the built-in `vscode.git` extension API. Runs `git blame --porcelain` with `--contents -` so unsaved buffers resolve correctly, and parses commit trailers. |
| `Resolver` | Turns *(document, line)* into an `Attribution` (algorithm below). |
| `AgentAdapter` | Per-agent interface: parse hook payloads, parse transcripts, render the thread. v1 ships `claudeCode`; `agentTrace` is export only. |
| `LineAnnotation` | The faded end-of-line decoration on the cursor line, with the hover card. |
| `ThreadPanel` | Webview that renders a transcript and scrolls to a `tool_use_id`. |
| `GutterHeatmap` | Optional per-line color bar by agent/model, plus a status bar summary. |
| `ThreadsView` | Tree view listing the threads that touched the active file. |
| `HookInstaller` | Installs `tt-capture.js` and merges hook config after confirmation. |

### Resolving a line

1. **Hash the line.** Read the line text and compute its strict and loose hashes. If the line is weak, use the nearest strong line above or below it in the same block.
2. **Blame.** Run `git blame --porcelain -L n,n --contents - -- <file>`. This gives the commit SHA (all zeros if the line is uncommitted), the original path, author, author time and summary.
3. **Collect candidates.** Keep edits where:
   - the file is the current path or the blame's original path;
   - the strict hash is in one of the edit's hunks;
   - the edit's `ts` is at or before the commit's author time plus 10 minutes. For uncommitted lines, any edit since HEAD's time qualifies.
4. **Pick the newest candidate** and grade it:
   - `exact`: strict hash matches, the line is within ±20 lines of the recorded hunk, and the time window holds.
   - `likely`: hash and time window hold, but the position has drifted or the record is a backfill with no position.
   - `modified`: no strict match, but the loose hash matches, or the line is at least 0.75 similar (normalized Levenshtein) to a line an agent wrote in the same region. The UI says “edited by you after Claude wrote it”.
   - `commit`: no edit matched, but the blamed commit has an agent trailer.
   - `none`: no match. Show plain blame.
5. **Build the history.** List older edits with the same hash, plus the line's commit chain from `git log -L n,n --format=…`. The commit chain is fetched only when the hover card is expanded. Together these give Zed's mixed list of threads and commits.

**Caching.**

- Blame results are cached by *(uri, document version)*.
- Commit metadata is cached by SHA, since commits never change.
- Resolution is debounced by 150 ms on cursor moves and only runs for the cursor line. The heatmap mode blames the whole file once on open and once per save.

## UX

### Current-line annotation

An `after` text decoration at the end of the cursor line, in the theme's faded foreground color:

- Agent-written line: `✦ Claude Opus 5.5 · 2h ago · 1 thread`
- Human line with agent history: `Julian, Yesterday · 1 thread`
- Human-only line: `Julian, Yesterday`

### Hover card (the core feature)

The card is attached through `DecorationOptions.hoverMessage`, so it opens when you hover the annotation and doesn't crowd normal IntelliSense hovers. It is a `MarkdownString` with `supportThemeIcons`, `supportHtml` and `isTrusted: { enabledCommands: [...] }`, with the allowed commands listed explicitly.

```
Line 3141                                     [≡] [💬] [⑂]
── This week ────────────────────────────────────────────
✦ Claude Opus 5.5 · claude-code · 2 days ago      [exact]
  > We have an action to collapse child threads, but we
  > don't have the opposite to uncollapse...
  Open thread · Copy prompt · Open on claude.ai

⑂ Add Expand Child Threads action
  Julian · Yesterday · d574e59
  Open commit · Diff
────────────────────────────────────────────────────────
1 thread · 1 commit
```

- **Entry order.** Entries are newest first and grouped by Today, This week and Older. Thread entries and commit entries are mixed together, as in Zed.
- **Thread entries** show:
  - the model (pretty-printed) and the agent;
  - the first two lines of the prompt;
  - the relative time;
  - a confidence badge (`exact` is shown quietly; `likely` and `modified` stand out more).
- **Header buttons** filter the list to all entries, threads only or commits only.

An optional setting, `threadTrace.hover.mode: "anywhere"`, also registers a `HoverProvider` for every language. It appends a compact one-line attribution to normal hovers. It is off by default because it is noisier.

### Thread panel

A `WebviewPanel` titled with the session's first prompt. It renders the transcript:

- **Content.** User prompts, assistant text, and tool calls collapsed into summaries such as “Ran 3 searches, read 13 files”. `Edit` and `Write` calls are shown as diffs.
- **Navigation.** The panel opens scrolled to the `tool_use_id` that wrote the hovered line and highlights it.
- **Header.** Shows agent, model, session id, time and branch, with buttons: **Open on claude.ai** (when `thread_url` is known), **Reveal transcript file** and **Copy prompt**.
- **Missing transcripts.** If the transcript isn't on this machine, for example because the work came from a cloud session, the panel shows the turn record plus the thread link.

### Other surfaces

- **Gutter heatmap** (toggle): a thin colored bar per line, one color per agent/model. The status bar shows `✦ 62% agent` for the file; clicking it opens a legend.
- **Agent Threads view** in the Explorer: lists the threads that touched the active file, with edit counts. Clicking one opens the thread panel.

### Commands

| Command | What it does |
| --- | --- |
| `threadTrace.showThreadForLine` | Opens the thread panel for the cursor line. |
| `threadTrace.copyPrompt` | Copies the prompt behind the cursor line. |
| `threadTrace.openOnWeb` | Opens `thread_url` in the browser. |
| `threadTrace.toggleAnnotation` / `toggleHeatmap` | Shows or hides each surface. |
| `threadTrace.installHooks` / `uninstallHooks` | Manages hooks (project or user scope). |
| `threadTrace.backfill` | Imports attribution from existing transcripts. |
| `threadTrace.exportAgentTrace` | Writes `.agent-trace/traces.jsonl`. |

### Settings

| Setting | Default | Notes |
| --- | --- | --- |
| `threadTrace.annotation.enabled` | `true` | Shows the end-of-line annotation. |
| `threadTrace.hover.mode` | `"annotation"` | `annotation` or `anywhere`. |
| `threadTrace.capture.prompt` | `"full"` | `full`, `firstLine` or `none`. |
| `threadTrace.capture.redact` | built-in patterns | Extra regexes to redact before writing. |
| `threadTrace.blame.detectMoves` | `false` | Adds `-M -C` to blame (slower). |
| `threadTrace.heatmap.enabled` | `false` | Shows the gutter heatmap. |

## Line resolution edge cases

The main design choice is that **records are keyed by line content, not by commit SHA or line number.** SHAs and line numbers change all the time; the text of a line an agent wrote mostly doesn't. Each edge case below follows from that choice.

| Case | Behavior |
| --- | --- |
| Uncommitted agent edit | Blame with `--contents -` returns the all-zero SHA. Match against edits since HEAD and show “not committed yet”. |
| Unsaved buffer changes | `--contents -` blames the buffer, so line numbers match what's on screen. |
| Human tweaks an agent line | The strict hash misses and blame points at the human's commit. A loose or fuzzy match gives `modified`. The card shows the human commit first, with the agent thread below it as “originally written by”. |
| Lines moved within a file | Hashes don't depend on position, so they still match. Confidence drops from `exact` to `likely`. |
| File renamed | Use the blame's original path and keep a rename map from `git log --follow --name-status`. |
| Rebase, amend or cherry-pick | SHAs change but author time is preserved. Matching uses hash plus author time, so nothing breaks. |
| Squash merge | The squash commit's author time can differ from the original commits'. When the commit has more than one parent in its PR or the summary matches a squash pattern, widen the time window to the session's lifetime. |
| Formatter rewrites the agent's output | Indent-only changes match through the loose hash. Larger reformatting fall back to fuzzy matching, giving `modified`. A v2 hook could re-hash after the formatter runs. |
| Same line written by several turns | Prefer the newest edit before the commit time. The card adds “also written in N other turns”. |
| Branch switch | The index is keyed by file and hash, not by branch. The time window and blame filter out edits that don't apply. |
| Session ran in the cloud | No local hook records exist, so attribution comes from commit trailers at `commit` confidence, with a link to the thread on the web. |

## Privacy, security and performance

### Privacy

- **Everything stays local.** Records live in `.git/thread-trace/`, which isn't committed. Transcripts are referenced by path, never copied.
- **Prompts can contain secrets.** Redact before writing: built-in patterns for API keys, tokens, `password=`-style pairs and private keys, plus the user's own patterns in `threadTrace.capture.redact`. `threadTrace.capture.prompt` can store only the first line, or nothing.
- **Sharing is explicit.** Records only leave the machine through the export command, which previews what it will write before writing it.

### Security

- **Workspace Trust.** In untrusted workspaces, hook install, backfill and the thread panel are disabled.
- **Hook script.** `tt-capture.js` parses stdin as JSON and nothing else. It never evaluates or shells out with payload content, and it writes only under `.git/thread-trace/` and `~/.thread-trace/`.
- **Transcript content is untrusted.** It can include HTML, file contents and prompt-injection text. Escape all of it in the webview, set a strict CSP (`default-src 'none'`, script only by nonce), load no remote resources, and allowlist which command URIs the hover card may run.
- **Hook installation requires consent.** Always show the exact settings diff and require confirmation. Never edit `settings.json` silently.

### Performance budgets

| Path | Budget |
| --- | --- |
| `tt-capture` hook run | under 50 ms at p95; no git subprocess |
| Annotation after the cursor settles | under 100 ms for a cached blame, under 300 ms uncached |
| Hover card render | under 50 ms after resolution |
| Extension activation | under 150 ms; load the index lazily on the first resolve |
| Index memory | about 200 bytes per edited line; at 1M lines, compact into a SQLite index (`better-sqlite3` or sql.js) |

Activate on `onStartupFinished`. Do nothing in folders that aren't git repos. Backfill runs with limited concurrency and a progress notification you can cancel.

## Milestones, file layout and acceptance tests

### Milestones

1. **M0: Scaffold.** Create the TypeScript extension with `yo code` and bundle with esbuild into two outputs, `dist/extension.js` and `dist/tt-capture.js`. Set up vitest for unit tests and `@vscode/test-electron` for integration tests.
2. **M1: Capture.** Build `tt-capture.js`, the hook installer and the JSONL writer. *Done when* one Claude Code session that edits three files produces matching turn and edit records with the model filled in.
3. **M2: Resolve and annotate.** Build `TraceStore`, `GitService`, `Resolver`, the end-of-line annotation and the hover card. *Done when* hovering an agent-written line shows the right prompt and model at `exact` confidence.
4. **M3: Thread panel.** Build the transcript adapter and the webview, including scroll-to-`tool_use_id`.
5. **M4: Backfill and trailers.** Import existing transcripts and add commit-level fallback from trailers.
6. **M5: Polish.** Add the heatmap, the Agent Threads view, the status bar summary, Agent Trace export and settings UI. Publish to the Marketplace and Open VSX.
7. **v2.** Add adapters for other agents (Codex, Cursor, Copilot agent mode), opt-in team sync through committed `.agent-trace/`, and post-formatter re-hashing.

### File layout

```
thread-trace/
├─ package.json            # contributes: commands, configuration, views, hover mode
├─ esbuild.mjs
├─ src/
│  ├─ extension.ts         # activate(): wire services, register UI
│  ├─ capture/
│  │  ├─ tt-capture.ts     # hook entry (bundled standalone, no vscode import)
│  │  ├─ lineRanges.ts     # new_string → hunks
│  │  └─ redact.ts
│  ├─ install/hookInstaller.ts
│  ├─ store/{schema.ts, traceStore.ts, hash.ts}
│  ├─ git/{blame.ts, trailers.ts, log.ts}
│  ├─ resolve/{resolver.ts, fuzzy.ts, weakLines.ts}
│  ├─ adapters/{types.ts, claudeCode.ts, agentTrace.ts}
│  └─ ui/{annotation.ts, hoverCard.ts, threadPanel.ts, heatmap.ts, threadsView.ts, statusBar.ts}
├─ media/threadPanel/{index.html, panel.css, panel.js}
└─ test/
   ├─ fixtures/            # sample hook payloads, transcripts, tiny git repos
   ├─ unit/                # hashing, lineRanges, resolver grading, trailers
   └─ integration/         # real VS Code + temp repo
```

### `package.json` (contributes excerpt)

```json
{
  "name": "thread-trace",
  "displayName": "Thread Trace — Agent Blame",
  "engines": { "vscode": "^1.90.0" },
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "extensionDependencies": ["vscode.git"],
  "capabilities": { "untrustedWorkspaces": { "supported": "limited" } },
  "contributes": {
    "commands": [
      { "command": "threadTrace.showThreadForLine", "title": "Thread Trace: Show Thread for Line" },
      { "command": "threadTrace.copyPrompt", "title": "Thread Trace: Copy Prompt for Line" },
      { "command": "threadTrace.installHooks", "title": "Thread Trace: Install Agent Hooks" },
      { "command": "threadTrace.backfill", "title": "Thread Trace: Backfill from Transcripts" },
      { "command": "threadTrace.toggleHeatmap", "title": "Thread Trace: Toggle Agent Heatmap" }
    ],
    "views": { "explorer": [{ "id": "threadTrace.threads", "name": "Agent Threads" }] },
    "configuration": { "title": "Thread Trace", "properties": { "threadTrace.hover.mode": {
      "type": "string", "enum": ["annotation", "anywhere"], "default": "annotation" } } }
  }
}
```

### Acceptance tests

1. **Exact attribution.** Claude Code writes `foo()` in session S under model M, and the user commits. Hovering the annotation shows M, the prompt and the commit, at `exact` confidence.
2. **Uncommitted.** Same as test 1 before committing: the card shows “not committed yet” at `exact` confidence.
3. **Human tweak.** The user renames a variable on an agent-written line and commits. The card shows the user's commit first and the agent thread second, at `modified` confidence.
4. **Rebase.** After an interactive rebase that rewrites the SHAs, tests 1 and 3 still pass.
5. **Weak lines.** A closing `}` the agent wrote takes the attribution of its block, and a `}` the human wrote isn't attributed to the agent.
6. **Thread panel.** Clicking **Open thread** opens the panel scrolled to the right `tool_use_id`, with the diff highlighted.
7. **Trailer only.** A commit with `Claude-Session:` and no local records shows `commit` confidence and an **Open on claude.ai** link.
8. **Backfill.** On a repo with past transcripts and no hook records, backfill attributes at least 90% of the agent lines that are still unchanged.
9. **Failure isolation.** If `tt-capture` hits malformed JSON or a read-only `.git`, it exits 0, logs the error and leaves the agent session unaffected.
10. **Safety.** A transcript containing `<script>` renders as text, and no hover link can run a command that isn't allowlisted.
11. **Performance.** On a 5,000-line file with 20k edit records, the annotation appears within 300 ms on a cold cache.

### Open questions

- Should records eventually be committed, so teammates see each other's threads? If so, store them in git notes or `.agent-trace/`, and decide whether to commit prompts at all.
- Should the hover ask an agent “why does this line exist?” and answer from the thread, like Diversion's Ask feature? That's a natural v2 once the thread is one click away.
- Should the card handle multi-line selections, attributing a whole function or range?

### References

- Zed agent blame demo (attached video): the reference UX.
- [Agent Trace overview](https://baeseokjae.github.io/posts/trace-file-lineage-agent-provenance-2026/): the JSONL sidecar spec for AI attribution.
- [Agent Trace × Jujutsu](https://dev.classmethod.jp/en/articles/agent-trace-jujutsu-ai-code-tracking/): writing traces from Claude Code hooks.
- [Diversion Claude Code plugin](https://www.diversion.dev/diversion-claude-code-plugin): links commits to the conversations that produced them.
- [thoughtdag](https://socket.dev/npm/package/thoughtdag): indexes local agent sessions by the files they touched.

## Capture: verified differences

Checked on Nov 15, 2026 against the [Claude Code hooks reference](https://code.claude.com/docs/en/hooks) and local transcripts (CLI 2.1.300–2.1.317; installed CLI 2.1.325). Where this section and the Capture section above disagree, this section is newer. Read it before starting M1.

1. **`MultiEdit` is not a current tool.** The docs list only `Edit` and `Write`, and their matcher is `Edit|Write`. `NotebookEdit` exists and isn't captured. Keeping `MultiEdit` in the matcher is harmless.
2. **The payload has more fields than listed above.** It also carries `tool_use_id`, `prompt_id`, `agent_id` / `agent_type` (for subagent edits), `duration_ms`, `permission_mode` and `effort`.
3. **`prompt_id` solves turn linking.** Attaching an edit to "the session's current turn" needs state that an append-only hook doesn't have. `prompt_id` is in the hook payloads and on transcript entries (`promptId`), so `Turn.id` can be `${session_id}:${prompt_id}`.
4. **stdout and exit 2 affect the agent.** On `UserPromptSubmit`, stdout on exit 0 is added to the model's context, and exit 2 blocks the prompt. `tt-capture` must print nothing and never exit 2. The default command-hook timeout is 600 s, lowered to 30 s on `UserPromptSubmit`.
5. **`async: true` exists for command hooks.** It runs the hook in the background, which suits the prompt hook. The edit hook reads the post-edit file, so async there can race the next edit.
6. **Cloud sessions do run hooks.** They skip only `~/.claude/settings.json`; project settings still apply. A project-scope install would call `node ~/.thread-trace/bin/tt-capture.js` where that file doesn't exist and show a hook error on every prompt and edit, in the cloud and for teammates. The install needs a guarded command or `.claude/settings.local.json`.
7. **Model lookup is harder than "read the last assistant entry".** The model is absent from the payload (only `SessionStart` sometimes has it). In real transcripts one assistant message is split into one entry per content block, up to 19 non-assistant entries followed the last assistant entry, single entries reach 129 KB, and files reach 4.6 MB. The hook needs a bounded backwards tail read to stay under 50 ms. Subagent edits live in `<session>/subagents/agent-<id>.jsonl`, so the main transcript can give the wrong model for them.
8. **`tool_response` is richer than documented.** Write results in transcripts (`toolUseResult`) carry `type`, `filePath`, `content`, `structuredPatch`, `originalFile` and `userModified`; the docs show only `filePath` and `type`. If Edit results look the same, line ranges can come from the patch instead of searching for `new_string`.
9. **Backfill needs filtering.**
   - `type: "user"` entries include slash commands, meta entries (`isMeta`) and tool results. Real prompts have `promptSource: "typed"` and `origin.kind: "human"`.
   - Rejected tool calls appear as a `tool_use` whose result has `is_error: true`, and must be skipped.
   - One file had `session_id` different from `sessionId` and from its filename.
   - Entries carry `version` and `gitBranch`, which covers "record the agent version on every record".
10. **Writes outside the repo appear in transcripts** (for example a scratchpad under `/tmp`). Capture and backfill must ignore them.

**Not verified.** Settle each by logging one real payload from each hook at the start of M1:

- The Edit `tool_response` shape. No local transcript contained an Edit call.
- Whether a subagent's `PostToolUse` payload carries the parent's `session_id` and `transcript_path`.
- The verbatim `UserPromptSubmit` payload, including the `prompt` field name.

### Hook payloads observed (M1 step 1)

Captured on Nov 15, 2026 from a real headless session (CLI 2.1.325) with logging hooks. Sanitized payloads are in `test/fixtures/hook-payloads/`. This settles the three "not verified" items above and adds four new findings.

**The three open items**

- **Edit `tool_response`:** `filePath`, `oldString`, `newString`, `originalFile`, `structuredPatch`, `userModified`, `replaceAll`. Each patch hunk is `{ oldStart, oldLines, newStart, newLines, lines }` with `+`/`-`/space-prefixed lines. Write has the same patch with `type: "update"`, and an empty patch plus `content` with `type: "create"`. So written line numbers and removed lines come from the payload; the hook doesn't need to read the file or search for `new_string`. For a Write that overwrites a file, only the changed lines need attributing, not the whole file.
- **Subagent `PostToolUse`:** carries the parent's `session_id`, `transcript_path` and `prompt_id`, plus `agent_id` and `agent_type`. The subagent's own entries are in `<transcript dir>/<session_id>/subagents/agent-<agent_id>.jsonl`, not in the main transcript.
- **`UserPromptSubmit`:** the prompt is in `prompt`, with `prompt_id`, `permission_mode`, `session_id`, `transcript_path` and `cwd`.

**New findings**

1. **The current tool call is not in the transcript when `PostToolUse` runs.** In all five edits, the assistant entry holding the `tool_use` reached disk after the hook ran. On the first edit of the session the transcript had no assistant entry at all, so "read the last assistant entry" returns nothing or the previous message's model. An `api-request` entry with `params.model` is on disk by then. The reliable source is a join on `tool_use_id` after the fact, so the hook should record a best-effort model and the read layer should correct it from the transcript.
2. **The transcript file doesn't exist yet** at `SessionStart` or at the first `UserPromptSubmit`. `SessionStart` carried no `model` field.
3. **`UserPromptSubmit` also fires for synthetic prompts.** A background subagent finishing produced a second `UserPromptSubmit` whose `prompt` starts with `<task-notification>`, with a new `prompt_id`. The hook payload has nothing that marks it as synthetic; the transcript entry does (`promptSource: "system"`, `origin.kind: "task-notification"`). Headless prompts have `promptSource: "sdk"`, not `"typed"`.
4. **Subagent edits can arrive after the main turn's `Stop`.** The background subagent's edit ran after `Stop` fired, still under the original `prompt_id`. A `Stop`-based verification pass can't assume the turn's edits are complete.

**Also observed**

- `cwd` was a subdirectory of the repo, and the transcript's project folder is encoded from that `cwd`, not from the repo root. `tool_input.file_path` is absolute.
- Hook processes get `CLAUDE_PROJECT_DIR`, `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_EXECPATH`; the last ends in the CLI version, which gives the agent version without reading the transcript.
- `Stop` carries `last_assistant_message` and `background_tasks`; `SubagentStop` carries `agent_transcript_path`.
- Reading a 240 KB transcript in full took about 2 ms.

### M1 decisions

Decided on Nov 15, 2026. Where these differ from the sections above, these are what the code does.

- **Turn id** is `${session_id}:${prompt_id}`, not `${session_id}:${turnIndex}`. The hook has no state to count turns with, and every prompt and edit payload carries `prompt_id`.
- **Model** is recorded by the hook as a best-effort value: whichever is newer of the last assistant entry and the last `api-request` entry in the transcript tail (the subagent's own transcript for subagent edits). The read layer (M2) corrects it by matching `tool_use_id` while the transcript still exists. Storing it in the record keeps the model after Claude Code deletes old transcripts.
- **Project-scope install** writes to `.claude/settings.local.json`, not `.claude/settings.json`, so the hook never runs in cloud sessions or for teammates who don't have the script. User scope (`~/.claude/settings.json`) is still offered. Both show the diff and need confirmation.
- **Hook command** is `node "<absolute path>/tt-capture.js" prompt|edit`, with the absolute path instead of `~`.
- **Line ranges** come from `tool_response.structuredPatch`. Searching the post-edit file for `new_string` is only a fallback for payloads without a patch. A Write over an existing file attributes only the lines it changed.
- **Schema additions:** `Hunk.loose` (loose hash per line, parallel to `hashes`), `Edit.agent_id` (subagent edits), and `Turn.origin` (`'human'` or `'agent'`). A prompt the agent submitted itself, such as a background-task notification, is recorded as an `'agent'` turn with an empty `prompt`.
- **Loose hash** removes all whitespace from the line, not just runs of it.
- **Capture settings** reach the hook through an optional `~/.thread-trace/config.json` (`{ "prompt": "full" | "firstLine" | "none", "redact": ["regex", …] }`). The extension doesn't write this file yet; the settings UI is M5.
- **Records live in the shared git dir**, so linked worktrees of one repo write to the same `thread-trace/` folder.
- **Extra files** beyond the layout: `src/capture/capture.ts` (the logic, separate from the entry so it can be tested), `src/capture/gitDir.ts`, and `src/install/hookConfig.ts` (the settings merge, free of `vscode`).

### M2 decisions

Decided on Nov 15, 2026. Where these differ from "Resolving a line", "UX" and "Line resolution edge cases", these are what the code does.

- **Uncommitted lines have no lower time bound.** "Any edit since HEAD's time" drops an agent line as soon as an unrelated commit lands before the line is committed.
- **The time window ends at the later of author and committer time, plus 10 minutes.** Author time alone misses agent edits amended into an older commit. A rebase moves committer time forward, which only widens the window.
- **Fuzzy matching reads the agent's wording from git**, because records hold hashes, not text. The resolver takes the file before the blamed commit (blame's `previous`), or at HEAD for an uncommitted change, and looks within 20 lines for a line that an agent wrote, that is no longer in the buffer, and that is at least 0.75 similar. An agent line tweaked before either version is committed reaches `modified` only through the loose hash.
- **Weak lines** are blank lines, lines with no letters or digits, and a short keyword list (`else`, `end`, `return`, `break`, `pass` and similar). There is no per-language list or frequency check. A weak line inherits from its nearest strong neighbor (up to 20 lines away, either side) only when both lines blame to the same commit and the edit's hunk holds the two hashes the same distance apart as in the file.
- **A file git has never committed** counts as uncommitted on every line, so a new file the agent wrote is attributed before the first commit.
- **Model correction** happens when a line is resolved: the adapter finds the assistant entry holding the edit's `tool_use_id` (in the subagent's transcript for subagent edits) and uses its model. The result is not written back; `edits.jsonl` stays append-only, and the hook's value is used once the transcript is gone.
- **The commit chain** (`git log -L`) is fetched in the background after the annotation shows, and the card is re-rendered with it. A hover can't report that it was expanded.
- **Card order:** the line's current thread and the commit it landed in come first (the commit first for `modified`, with the thread under "Originally written by"), then older threads and commits, newest first, under Today / This week / Older.
- **Card links** in M2 are Copy prompt, Diff, Copy SHA and the three filter buttons; Open on claude.ai appears only for an `https://` `thread_url`. Open thread comes with the panel in M3. Links carry ids, and the commands validate them.
- **The read side is off in untrusted workspaces**, because blame runs git in the repo and a repo's git config can run commands.
- **The store refreshes on every resolve** (two stats when nothing changed) as well as on `fs.watch`, which is unreliable on WSL and can't watch a folder that doesn't exist yet.
- **Not built yet:** `commit` confidence and trailers (M4), the `--follow` rename map (blame's original path covers committed renames), the squash-merge window, `blame.detectMoves`, and `hover.mode: "anywhere"`.
- **Extra files** beyond the layout: `src/git/exec.ts` (runs git), `src/git/gitService.ts` (the only git file that imports `vscode`), `src/store/jsonlTail.ts` (incremental JSONL reads, shared by the store and the adapter), and `test/unit/helpers/repo.ts`.

### M3 decisions

Decided on Nov 15, 2026. Where these differ from "Thread panel", these are what the code does.

- **Transcript entries the panel uses** (checked against local transcripts, CLI 2.1.325):
  - An assistant message is one entry per content block. `text` and `tool_use` blocks are shown; `thinking` blocks are not.
  - A user entry whose content holds `tool_result` blocks carries a tool's result. `is_error: true` marks a failed or rejected call. For `Edit` and `Write`, `toolUseResult.structuredPatch` is the diff; a created file has an empty patch and the content in the call's input.
  - A user entry with text is a real prompt when `origin.kind` is `human` or `promptSource` is `typed` or `sdk`. `promptSource: "system"` or another origin is a prompt Claude Code submitted itself. `isMeta` entries and entries with neither field (slash commands and their output) are skipped.
  - A subagent's transcript opens with a plain user entry (`isSidechain: true`) holding the task its parent gave it.
- **Nothing is rendered as Markdown.** Prompts and assistant text are shown as escaped plain text. This keeps the "transcript content is untrusted" rule simple to hold.
- **The page is built in TypeScript** (`src/ui/threadHtml.ts`, no `vscode` import), not from `media/threadPanel/index.html`, which is removed. `panel.css` and `panel.js` stay in `media/`. The CSP is `default-src 'none'`, the panel stylesheet, and one script by nonce.
- **The webview sends action names only** (`copyPrompt`, `revealTranscript`, `openWeb`, `revealed`). The extension picks the prompt, file or URL from its own state.
- **Tool calls** between other items collapse into one summary, such as "Ran 3 searches, read 13 files", that opens to a list. Tool output is not shown.
- **A Write over an existing file** shows the patch, not the whole file. An edit whose result isn't in the transcript yet shows a diff rebuilt from the call's input, without line numbers. A rejected edit is marked "not applied".
- **Subagent edits:** the panel shows the session's transcript, then the subagent's own transcript under a "Subagent" heading, and scrolls to the call there.
- **One panel per session.** Opening another line of the same session reuses it and scrolls to the new call.
- **Long content is cut:** text at 8,000 characters and diffs at 400 lines, with a note of how much was left out.
- **Missing transcript:** the panel shows the recorded prompt, the edit's tool, file and line count, and the web link when there is one. The diff exists only in the transcript.
- **The store parses edit records one file at a time**, on the first lookup for that file. Parsing and indexing all 20k records of acceptance test 11 took about 200 ms, most of the 300 ms budget.
- **Extra file** beyond the layout: `src/ui/threadHtml.ts`.
