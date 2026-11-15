// Hook entry for Claude Code: `node tt-capture.js prompt|edit`, payload on stdin.
// Bundled standalone into dist/tt-capture.js. Must never import vscode.
//
// Rules that hold from the first version (docs/SPEC.md, "Hook rules"):
//   - Always exit 0. A tracing bug must never block the agent.
//   - Never write to stdout. Claude Code adds a UserPromptSubmit hook's stdout
//     to the model's context.
//
// Stub: capture itself is implemented in M1. For now this drains stdin and exits.

function exitOk(): never {
  process.exit(0);
}

process.on('uncaughtException', exitOk);
process.on('unhandledRejection', exitOk);

try {
  if (process.stdin.isTTY) {
    exitOk();
  }
  process.stdin.on('error', exitOk);
  process.stdin.on('end', exitOk);
  process.stdin.resume();
} catch {
  exitOk();
}
