import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// These tests run against the built bundles; `npm test` builds first.
const root = path.resolve(__dirname, '../..');
const extensionBundle = path.join(root, 'dist/extension.js');
const captureBundle = path.join(root, 'dist/tt-capture.js');

describe('build outputs', () => {
  it('produces dist/extension.js and dist/tt-capture.js', () => {
    expect(existsSync(extensionBundle)).toBe(true);
    expect(existsSync(captureBundle)).toBe(true);
  });

  it('keeps vscode out of the standalone capture bundle', () => {
    const source = readFileSync(captureBundle, 'utf8');
    expect(source).not.toMatch(/require\(["']vscode["']\)/);
  });
});

// Acceptance test 9 (failure isolation), as far as it applies before M1:
// whatever arrives on stdin, the hook exits 0 and stays silent on stdout.
describe('tt-capture never affects the agent', () => {
  // Keep the hook's failure log out of the real ~/.thread-trace.
  const home = mkdtempSync(path.join(os.tmpdir(), 'tt-scaffold-'));
  const env = { ...process.env, THREAD_TRACE_HOME: home };
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  const cases: [name: string, mode: string, stdin: string][] = [
    ['edit with malformed JSON', 'edit', '{not json'],
    ['prompt with malformed JSON', 'prompt', '{"session_id": '],
    ['edit with empty stdin', 'edit', ''],
    ['prompt with empty stdin', 'prompt', ''],
    ['unknown mode', 'bogus', '{}'],
  ];

  it.each(cases)('%s: exits 0 with no stdout', (_name, mode, stdin) => {
    const result = spawnSync(process.execPath, [captureBundle, mode], {
      input: stdin,
      encoding: 'utf8',
      timeout: 5000,
      env,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('exits 0 with no arguments', () => {
    const result = spawnSync(process.execPath, [captureBundle], {
      input: '',
      encoding: 'utf8',
      timeout: 5000,
      env,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });
});
