# Thread Trace

VS Code extension: hover a line → which agent/model/prompt wrote it.
Full spec: docs/SPEC.md. Read the relevant section before starting a milestone.

The last sections of docs/SPEC.md ("Capture: verified differences" and its
subsections "Hook payloads observed", "M1 decisions", "M2 decisions",
"M3 decisions", "M4 decisions", "M5 decisions") are newer than the rest and override it where
they disagree. Read them before touching capture, backfill, the schema, the
store, the resolver or the UI.
Record new decisions the same way, in an "Mn decisions" subsection.

## Commands

- npm run watch / npm run build / npm test / npm run lint
- npm run test:integration (runs in a real VS Code; downloads it on first run).
  New integration suites must be added to the list in esbuild.mjs.
- F5 launches the Extension Development Host

## Rules

- src/capture/ must never import vscode; it's bundled standalone for the hook.
  The same goes for what it imports: src/store/hash.ts, src/store/schema.ts,
  src/adapters/types.ts, src/adapters/claudeCode.ts.
- Only extension.ts, install/hookInstaller.ts, git/gitService.ts, ui/annotation.ts,
  ui/threadPanel.ts, ui/heatmap.ts, ui/statusBar.ts and ui/threadsView.ts import
  vscode. Keep everything else (store, resolver, git parsing, backfill, hoverCard.ts,
  threadHtml.ts, fileSummary.ts, agentTrace.ts, captureConfig.ts, hookScript.ts) free of it so it
  can be unit tested.
- tt-capture must always exit 0, never write to stdout, and never block the agent.
- Never edit ~/.claude/settings.json without a confirmation step.
- Every milestone ships with tests from the spec's acceptance list.
- Tests that run tt-capture or backfill must set THREAD_TRACE_HOME to a temp dir,
  so nothing is written to the real ~/.thread-trace. Backfill tests also set
  CLAUDE_CONFIG_DIR, so the real ~/.claude/projects is never read.
- Claude Code's payload and transcript formats are internals. Keep all knowledge
  of them in src/adapters/claudeCode.ts. Real payloads: test/fixtures/hook-payloads/.
- Transcript and prompt content is untrusted. Render it as escaped plain text,
  never Markdown or HTML. Hover links are built only in hoverCard.ts, may run
  only its allowlisted commands, and carry ids that the commands validate.
  The webview sends action names only.
- The read side (anything that runs git) stays off in untrusted workspaces.
- edits.jsonl is append-only. Derived values (like the corrected model) are
  computed at resolve time, never written back. Backfill only appends, and
  skips edits whose tool_use_id is already recorded.
- Tree items, quick picks and the status bar get record content as plain strings,
  never MarkdownString.
- The Agent Trace export never includes prompts, transcript paths or cwd, describes
  HEAD (not the working tree), and writes only after the preview is confirmed.
- threadTrace.capture.* stay `scope: "application"`: a workspace must not be able
  to change what the hook captures.
- Commit messages are untrusted too. A session link from a trailer is opened
  only when trailers.ts accepted it (https://claude.ai/ only), and hover links
  carry the commit sha, never the URL.

## Milestones

- M0 scaffold: done.
- M1 capture: done. Hook, redaction, install/uninstall commands. The installer's
  interactive flow (picker, diff, confirm) has not been tried by hand yet.
- M2 resolve and annotate: done. TraceStore, GitService, Resolver, end-of-line
  annotation, hover card, model correction from the transcript.
- M3 thread panel: done. Transcript adapter, webview, scroll to tool_use_id.
- M4 backfill and trailers: done. `threadTrace.backfill`, `commit` confidence
  from trailers, the `--follow` rename map, `blame.detectMoves`,
  `hover.mode: "anywhere"`. The squash-merge window turned out not to be needed.
  The backfill command's progress notification has not been tried by hand yet.
- M5 polish: done, except publishing. Heatmap, status bar summary and legend,
  Agent Threads view, Agent Trace export, capture settings synced to
  ~/.thread-trace/config.json. Not tried by hand yet: how the heatmap bars and the
  legend's color swatches look, the Agent Threads view in the Explorer, and the
  export's preview and confirmation dialog.
- Publishing (Marketplace, Open VSX): not started. Needs a README, LICENSE and icon,
  `private` removed, and the three by-hand checks above.
- v1.1 (spec, "Phasing"): next. Intent + trigger, rationale snippet, verified badge,
  Continue this thread.

## Current milestone: v1.1
