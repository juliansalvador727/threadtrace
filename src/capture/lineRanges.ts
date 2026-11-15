// Turns one edit into the line hunks it wrote and the hashes of the lines it removed.
//
// Preferred source: the `structuredPatch` in the hook's tool_response, which
// gives post-edit line numbers directly. Fallback (no patch in the payload):
// search the post-edit file for `new_string`, as the original spec describes.
import { looseHash, splitLines, strictHash } from '../store/hash';
import type { Hunk } from '../store/schema';

export interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Unified-diff lines prefixed with '+', '-' or ' ' (or '\' for the no-newline marker). */
  lines: string[];
}

export interface LineChanges {
  hunks: Hunk[];
  removed_hashes: string[];
}

function hunkFromLines(start: number, lines: string[]): Hunk {
  return {
    start,
    end: start + lines.length - 1,
    hashes: lines.map(strictHash),
    loose: lines.map(looseHash),
  };
}

/** Written hunks and removed hashes from a structured patch. */
export function changesFromPatch(patch: PatchHunk[]): LineChanges {
  const hunks: Hunk[] = [];
  const removed: string[] = [];
  for (const patchHunk of patch) {
    let newLine = patchHunk.newStart;
    let run: string[] = [];
    let runStart = 0;
    const flush = () => {
      if (run.length > 0) hunks.push(hunkFromLines(runStart, run));
      run = [];
    };
    for (const line of patchHunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === '+') {
        if (run.length === 0) runStart = newLine;
        run.push(text);
        newLine++;
      } else if (marker === '-') {
        flush();
        removed.push(strictHash(text));
      } else if (marker === ' ') {
        flush();
        newLine++;
      } else {
        // '\ No newline at end of file' and anything unknown: not a content line.
        flush();
      }
    }
    flush();
  }
  return { hunks, removed_hashes: removed };
}

/** A newly created file: every line was written. */
export function changesFromNewFile(content: string): LineChanges {
  const lines = splitLines(content);
  return { hunks: lines.length > 0 ? [hunkFromLines(1, lines)] : [], removed_hashes: [] };
}

/**
 * Fallback: find where `newString` landed in the post-edit file. Returns the
 * first occurrence, or all of them when `replaceAll` is set.
 */
export function changesFromSearch(
  fileText: string,
  oldString: string,
  newString: string,
  replaceAll: boolean,
): LineChanges {
  const removed = splitLines(oldString).map(strictHash);
  const written = splitLines(newString);
  const hunks: Hunk[] = [];
  if (newString !== '' && written.length > 0) {
    let from = 0;
    for (;;) {
      const index = fileText.indexOf(newString, from);
      if (index === -1) break;
      // 1-based line of the match start = newlines before it + 1.
      let start = 1;
      for (let i = 0; i < index; i++) if (fileText.charCodeAt(i) === 10) start++;
      hunks.push(hunkFromLines(start, written));
      if (!replaceAll) break;
      from = index + newString.length;
    }
  }
  return { hunks, removed_hashes: removed };
}

/**
 * A replacement whose position isn't known, as when a transcript has the tool
 * call but no patch: the written lines' hashes, with no line numbers.
 */
export function changesFromText(oldString: string, newString: string): LineChanges {
  const written = splitLines(newString);
  return {
    hunks: written.length > 0 ? [{ hashes: written.map(strictHash), loose: written.map(looseHash) }] : [],
    removed_hashes: splitLines(oldString).map(strictHash),
  };
}
