# Thread Trace

VS Code extension: hover a line → which agent/model/prompt wrote it.
Full spec: docs/SPEC.md. Read the relevant section before starting a milestone.

The last three sections of docs/SPEC.md ("Capture: verified differences",
"Hook payloads observed", "M1 decisions") are newer than the rest and override
it where they disagree. Read them before touching capture, the schema or the store.

## Commands

- npm run watch / npm run build / npm test / npm run lint
- npm run test:integration (runs in a real VS Code; downloads it on first run)
- F5 launches the Extension Development Host

## Rules

- src/capture/ must never import vscode; it's bundled standalone for the hook.
  The same goes for what it imports: src/store/hash.ts, src/store/schema.ts,
  src/adapters/types.ts, src/adapters/claudeCode.ts.
- tt-capture must always exit 0, never write to stdout, and never block the agent.
- Never edit ~/.claude/settings.json without a confirmation step.
- Every milestone ships with tests from the spec's acceptance list.
- Tests that run tt-capture must set THREAD_TRACE_HOME to a temp dir, so nothing
  is written to the real ~/.thread-trace.
- Claude Code's payload and transcript formats are internals. Keep all knowledge
  of them in src/adapters/claudeCode.ts. Real payloads: test/fixtures/hook-payloads/.

## Milestones

- M0 scaffold: done.
- M1 capture: done. Hook, redaction, install/uninstall commands. The installer's
  interactive flow (picker, diff, confirm) has not been tried by hand yet.
- M2 resolve and annotate: next. TraceStore, GitService, Resolver, end-of-line
  annotation, hover card. Includes correcting each edit's model by matching
  tool_use_id in the transcript (the hook's value is best effort).

## Current milestone: M2
