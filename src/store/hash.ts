// Line hashing (docs/SPEC.md, "Line hashing"). Node-only: this module is also
// bundled into the standalone hook, so it must never import vscode.
import { createHash } from 'node:crypto';

const HASH_LENGTH = 12;

function sha1Prefix(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex').slice(0, HASH_LENGTH);
}

/** Drops a trailing CR (CRLF files) and any trailing whitespace. */
export function normalizeLine(line: string): string {
  return line.replace(/\s+$/, '');
}

/** Hash of the line with only trailing whitespace ignored. */
export function strictHash(line: string): string {
  return sha1Prefix(normalizeLine(line));
}

/** Hash of the line with all whitespace removed. Survives formatter re-indents. */
export function looseHash(line: string): string {
  return sha1Prefix(line.replace(/\s+/g, ''));
}

/** Splits text into lines on LF or CRLF. A single trailing newline doesn't add an empty last line. */
export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}
