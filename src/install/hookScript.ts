// The installed copy of tt-capture.js, and whether the `node` that runs it can
// be found. Plain Node, no vscode, so it can be unit-tested. hookInstaller.ts
// and extension.ts call it.
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Where the hook script lives. `home` is traceHome(): ~/.thread-trace, or THREAD_TRACE_HOME. */
export function installedScriptPath(home: string): string {
  return path.join(home, 'bin', 'tt-capture.js');
}

/**
 * Copies the bundled script to `installed` through a temporary file and a
 * rename, so a hook starting at the same moment reads the old script or the
 * new one, never half of one.
 */
export function copyScript(bundled: string, installed: string): void {
  fs.mkdirSync(path.dirname(installed), { recursive: true });
  const temp = `${installed}.${process.pid}.tmp`;
  try {
    fs.copyFileSync(bundled, temp);
    fs.renameSync(temp, installed);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

export type RefreshResult = 'absent' | 'current' | 'updated';

/**
 * Brings an installed script up to date with the bundled one, so an extension
 * update reaches the hook without reinstalling. Only an existing copy is
 * replaced: no copy means the hooks were never installed (or were removed),
 * and nothing is created. Settings files are never touched.
 */
export function refreshInstalledScript(bundled: string, installed: string): RefreshResult {
  let current: Buffer;
  try {
    current = fs.readFileSync(installed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'absent';
    throw error;
  }
  if (current.equals(fs.readFileSync(bundled))) return 'current';
  copyScript(bundled, installed);
  return 'updated';
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

/**
 * Looks `name` up on PATH the way a shell would, and returns the first match.
 * On Windows each PATHEXT extension is tried too. This is VS Code's PATH, which
 * can differ from the one Claude Code runs hooks with, so a miss is a reason to
 * warn, not proof.
 */
export function findExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exists: (file: string) => boolean = isFile,
): string | undefined {
  const windows = platform === 'win32';
  // Windows environment keys are case-insensitive; process.env hides that, a plain object doesn't.
  const lookup = (key: string) =>
    windows ? Object.entries(env).find(([k]) => k.toUpperCase() === key)?.[1] : env[key];
  const dirs = (lookup('PATH') ?? '').split(windows ? ';' : ':').filter((dir) => dir !== '');
  const extensions = windows
    ? ['', ...(lookup('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter((ext) => ext !== '')]
    : [''];
  const join = windows ? path.win32.join : path.posix.join;
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, name + ext);
      if (exists(candidate)) return candidate;
    }
  }
  return undefined;
}
