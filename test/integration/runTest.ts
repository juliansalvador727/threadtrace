import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

// Downloads VS Code if needed, launches it with this extension loaded, and
// runs the mocha suite inside the Extension Development Host.
async function main(): Promise<void> {
  // Bundled to out/test/integration/runTest.js, so the repo root is three levels up.
  const extensionDevelopmentPath = path.resolve(__dirname, '../../..');
  const extensionTestsPath = path.resolve(__dirname, 'suite/index.js');
  await runTests({ extensionDevelopmentPath, extensionTestsPath });
}

main().catch((err) => {
  console.error('Integration tests failed:', err);
  process.exit(1);
});
