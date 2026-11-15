// Follows an append-only JSONL file: each read returns only the complete lines
// added since the previous one. Node-only: the Claude Code adapter uses it, and
// the adapter is bundled into the standalone hook, so it must never import vscode.
import * as fs from 'node:fs';

export interface TailRead {
  /** Complete, non-empty lines appended since the last read. */
  lines: string[];
  /** True when the file shrank or vanished, so earlier lines no longer hold and `lines` starts from the top. */
  reset: boolean;
}

export class JsonlFollower {
  private offset = 0;

  constructor(readonly file: string) {}

  read(): TailRead {
    let fd: number;
    try {
      fd = fs.openSync(this.file, 'r');
    } catch {
      const reset = this.offset > 0;
      this.offset = 0;
      return { lines: [], reset };
    }
    try {
      const size = fs.fstatSync(fd).size;
      let reset = false;
      if (size < this.offset) {
        this.offset = 0;
        reset = true;
      }
      if (size === this.offset) return { lines: [], reset };
      const buffer = Buffer.alloc(size - this.offset);
      const read = fs.readSync(fd, buffer, 0, buffer.length, this.offset);
      // A writer may be mid-line: stop at the last newline and pick the rest up next time.
      const end = read > 0 ? buffer.lastIndexOf(10, read - 1) : -1;
      if (end === -1) return { lines: [], reset };
      this.offset += end + 1;
      const lines = buffer
        .toString('utf8', 0, end)
        .split('\n')
        .filter((line) => line !== '');
      return { lines, reset };
    } finally {
      fs.closeSync(fd);
    }
  }
}
