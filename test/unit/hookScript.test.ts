import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyScript, findExecutable, installedScriptPath, refreshInstalledScript } from '../../src/install/hookScript';

let dir: string;
let bundled: string;
let installed: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'tt-hookscript-'));
  bundled = path.join(dir, 'dist', 'tt-capture.js');
  installed = installedScriptPath(path.join(dir, 'home'));
  mkdirSync(path.dirname(bundled), { recursive: true });
  writeFileSync(bundled, '// new version\n');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('installedScriptPath', () => {
  it('is bin/tt-capture.js under the trace home', () => {
    expect(installedScriptPath('/h/.thread-trace')).toBe(path.join('/h/.thread-trace', 'bin', 'tt-capture.js'));
  });
});

describe('copyScript', () => {
  it('creates the directory and leaves no temporary file behind', () => {
    copyScript(bundled, installed);
    expect(readFileSync(installed, 'utf8')).toBe('// new version\n');
    expect(readdirSync(path.dirname(installed))).toEqual(['tt-capture.js']);
  });

  it('cleans up the temporary file when the copy fails', () => {
    expect(() => copyScript(path.join(dir, 'missing.js'), installed)).toThrow();
    expect(existsSync(installed)).toBe(false);
    expect(readdirSync(path.dirname(installed))).toEqual([]);
  });
});

describe('refreshInstalledScript', () => {
  it('creates nothing when the hooks were never installed', () => {
    expect(refreshInstalledScript(bundled, installed)).toBe('absent');
    expect(existsSync(installed)).toBe(false);
  });

  it('replaces an installed script from an older version', () => {
    mkdirSync(path.dirname(installed), { recursive: true });
    writeFileSync(installed, '// old version\n');
    expect(refreshInstalledScript(bundled, installed)).toBe('updated');
    expect(readFileSync(installed, 'utf8')).toBe('// new version\n');
    expect(readdirSync(path.dirname(installed))).toEqual(['tt-capture.js']);
  });

  it('leaves a current script alone', () => {
    copyScript(bundled, installed);
    expect(refreshInstalledScript(bundled, installed)).toBe('current');
  });

  it('throws when the bundled script is missing, without touching the installed one', () => {
    mkdirSync(path.dirname(installed), { recursive: true });
    writeFileSync(installed, '// old version\n');
    expect(() => refreshInstalledScript(path.join(dir, 'missing.js'), installed)).toThrow();
    expect(readFileSync(installed, 'utf8')).toBe('// old version\n');
  });
});

describe('findExecutable', () => {
  const present = (...files: string[]) => (file: string) => files.includes(file);

  it('returns the first PATH entry that has it', () => {
    const env = { PATH: '/usr/local/bin:/usr/bin::/opt/node/bin' };
    expect(findExecutable('node', env, 'linux', present('/usr/bin/node', '/opt/node/bin/node'))).toBe('/usr/bin/node');
  });

  it('returns undefined when no PATH entry has it', () => {
    expect(findExecutable('node', { PATH: '/usr/bin:/bin' }, 'linux', present())).toBeUndefined();
  });

  it('returns undefined with no PATH at all', () => {
    expect(findExecutable('node', {}, 'darwin', () => true)).toBeUndefined();
  });

  it('tries PATHEXT on Windows, with case-insensitive keys', () => {
    const env = { Path: 'C:\\Windows;C:\\Program Files\\nodejs', PathExt: '.COM;.EXE' };
    expect(findExecutable('node', env, 'win32', present('C:\\Program Files\\nodejs\\node.EXE'))).toBe(
      'C:\\Program Files\\nodejs\\node.EXE',
    );
  });

  it('falls back to the default PATHEXT on Windows', () => {
    expect(findExecutable('node', { PATH: 'C:\\nodejs' }, 'win32', present('C:\\nodejs\\node.EXE'))).toBe('C:\\nodejs\\node.EXE');
  });

  it('finds a real file on disk', () => {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'node'), '');
    mkdirSync(path.join(bin, 'nodedir'));
    expect(findExecutable('node', { PATH: bin }, 'linux')).toBe(path.join(bin, 'node'));
    // A directory with the name doesn't count.
    expect(findExecutable('nodedir', { PATH: bin }, 'linux')).toBeUndefined();
  });
});
