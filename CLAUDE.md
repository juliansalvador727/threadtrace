# Thread Trace

VS Code extension: hover a line → which agent/model/prompt wrote it.
Full spec: docs/SPEC.md. Read the relevant section before starting a milestone.

## Commands

- npm run watch / npm run build / npm test
- F5 launches the Extension Development Host

## Rules

- src/capture/ must never import vscode; it's bundled standalone for the hook.
- tt-capture must always exit 0 and never block the agent.
- Never edit ~/.claude/settings.json without a confirmation step.
- Every milestone ships with tests from the spec's acceptance list.

## Current milestone: M0
