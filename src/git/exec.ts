// Runs git in one repo. Plain Node, no vscode.
import { spawn } from 'node:child_process';

export interface GitResult {
  /** Exit code, or -1 when git couldn't be started or was killed. */
  code: number;
  stdout: string;
  stderr: string;
}

export class Git {
  constructor(
    /** Working tree root; every command runs here. */
    readonly root: string,
    private readonly gitPath = 'git',
    private readonly timeoutMs = 10_000,
  ) {}

  /** Never rejects: a failure comes back as a non-zero `code`. */
  run(args: string[], stdin?: string): Promise<GitResult> {
    return new Promise((resolve) => {
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const done = (code: number, extra = '') =>
        resolve({
          code,
          stdout: Buffer.concat(out).toString('utf8'),
          stderr: Buffer.concat(err).toString('utf8') + extra,
        });
      try {
        const child = spawn(this.gitPath, args, {
          cwd: this.root,
          // Read-only use: don't take locks that could disturb a git command the user is running.
          // LC_ALL=C keeps error messages in the form blame.ts matches on.
          env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' },
          windowsHide: true,
        });
        const timer = setTimeout(() => child.kill(), this.timeoutMs);
        child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
        child.on('error', (error) => {
          clearTimeout(timer);
          done(-1, String(error));
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          done(code ?? -1);
        });
        // git may exit before reading all of stdin (e.g. on a bad path).
        child.stdin.on('error', () => {});
        child.stdin.end(stdin ?? '');
      } catch (error) {
        done(-1, String(error));
      }
    });
  }
}
