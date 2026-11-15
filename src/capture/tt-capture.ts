// Hook entry for Claude Code: `node tt-capture.js prompt|edit`, payload on stdin.
// Bundled standalone into dist/tt-capture.js. Must never import vscode.
//
// Rules (docs/SPEC.md, "Hook rules"):
//   - Always exit 0. A tracing bug must never block the agent.
//   - Never write to stdout. Claude Code adds a UserPromptSubmit hook's stdout
//     to the model's context.
import { logFailure, runCapture } from './capture';

function exitOk(): never {
  process.exit(0);
}

const mode = process.argv[2];

process.on('uncaughtException', (error) => {
  logFailure(process.env, String(mode), error);
  exitOk();
});
process.on('unhandledRejection', (error) => {
  logFailure(process.env, String(mode), error);
  exitOk();
});

try {
  if (process.stdin.isTTY) exitOk();
  const chunks: Buffer[] = [];
  process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
  process.stdin.on('error', exitOk);
  process.stdin.on('end', () => {
    runCapture(mode, Buffer.concat(chunks).toString('utf8'), { env: process.env });
    exitOk();
  });
} catch (error) {
  logFailure(process.env, String(mode), error);
  exitOk();
}
