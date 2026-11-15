// Loads and follows turns.jsonl / edits.jsonl and indexes edits by file and hash
// (docs/SPEC.md, "Extension architecture"). Plain Node, no vscode, so it can be
// unit-tested directly.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { findRepo } from '../capture/gitDir';
import { JsonlFollower } from './jsonlTail';
import type { Edit, Turn } from './schema';

type HashIndex = Map<string, Map<string, Edit[]>>;

function addToIndex(index: HashIndex, file: string, hashes: Iterable<string>, edit: Edit): void {
  let byHash = index.get(file);
  if (!byHash) index.set(file, (byHash = new Map()));
  for (const hash of hashes) {
    const edits = byHash.get(hash);
    if (edits) edits.push(edit);
    else byHash.set(hash, [edit]);
  }
}

function parse<T extends { v: number; id: string }>(line: string): T | undefined {
  try {
    const record = JSON.parse(line) as T;
    return record && typeof record === 'object' && typeof record.id === 'string' ? record : undefined;
  } catch {
    return undefined;
  }
}

const FILE_KEY = '"file":"';

/**
 * The `file` of an edit record, read without parsing the line. The hook
 * writes `file` after scalar fields only, so the first `"file":"` in the line
 * is the top-level key (inside a string value the quotes would be escaped).
 */
function fileOf(line: string): string | undefined {
  const start = line.indexOf(FILE_KEY);
  if (start === -1) return undefined;
  const from = start + FILE_KEY.length;
  let end = from;
  while (end < line.length && line[end] !== '"') end += line[end] === '\\' ? 2 : 1;
  if (end >= line.length) return undefined;
  const raw = line.slice(from, end);
  if (!raw.includes('\\')) return raw;
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return undefined;
  }
}

export class TraceStore {
  private readonly turnsFile: JsonlFollower;
  private readonly editsFile: JsonlFollower;
  private turns = new Map<string, Turn>();
  private strictIndex: HashIndex = new Map();
  private looseIndex: HashIndex = new Map();
  /**
   * Edit lines not parsed yet, by file. Parsing and indexing every record is
   * most of the cost of a cold start, and a lookup only needs one file's.
   */
  private unparsed = new Map<string, string[]>();
  private edits = 0;
  private watcher: fs.FSWatcher | undefined;
  private watchTimer: NodeJS.Timeout | undefined;
  private listeners = new Set<() => void>();

  /** `dir` is `<shared git dir>/thread-trace`. It doesn't have to exist yet. */
  constructor(readonly dir: string) {
    this.turnsFile = new JsonlFollower(path.join(dir, 'turns.jsonl'));
    this.editsFile = new JsonlFollower(path.join(dir, 'edits.jsonl'));
  }

  /** The store for the repo that contains `startDir`, or undefined outside a git repo. */
  static forRepo(startDir: string): TraceStore | undefined {
    const repo = findRepo(startDir);
    return repo ? new TraceStore(path.join(repo.commonDir, 'thread-trace')) : undefined;
  }

  /**
   * Reads whatever was appended since the last call. Cheap when nothing
   * changed (two stats), so callers run it before every lookup instead of
   * relying on the file watcher alone.
   */
  refresh(): boolean {
    let changed = false;

    const turns = this.turnsFile.read();
    if (turns.reset) {
      this.turns = new Map();
      changed = true;
    }
    for (const line of turns.lines) {
      const turn = parse<Turn>(line);
      if (!turn) continue;
      this.turns.set(turn.id, turn);
      changed = true;
    }

    const edits = this.editsFile.read();
    if (edits.reset) {
      this.strictIndex = new Map();
      this.looseIndex = new Map();
      this.unparsed = new Map();
      this.edits = 0;
      changed = true;
    }
    for (const line of edits.lines) {
      const file = fileOf(line);
      if (file === undefined) continue;
      const lines = this.unparsed.get(file);
      if (lines) lines.push(line);
      else this.unparsed.set(file, [line]);
      this.edits++;
      changed = true;
    }

    this.ensureWatching();
    return changed;
  }

  /** Edits that wrote a line with this strict hash to `file`, in the order they were recorded. */
  strict(file: string, hash: string): Edit[] {
    this.index(file);
    return this.strictIndex.get(file)?.get(hash) ?? [];
  }

  /** Edits that wrote a line with this loose (whitespace-free) hash to `file`. */
  loose(file: string, hash: string): Edit[] {
    this.index(file);
    return this.looseIndex.get(file)?.get(hash) ?? [];
  }

  turn(id: string): Turn | undefined {
    return this.turns.get(id);
  }

  /** Number of edit records read so far. */
  get editCount(): number {
    return this.edits;
  }

  /** Parses and indexes the edits of one file that haven't been looked at yet. */
  private index(file: string): void {
    const lines = this.unparsed.get(file);
    if (!lines) return;
    this.unparsed.delete(file);
    for (const line of lines) {
      const edit = parse<Edit>(line);
      if (!edit || edit.file !== file || !Array.isArray(edit.hunks)) continue;
      const strict = new Set<string>();
      const loose = new Set<string>();
      for (const hunk of edit.hunks) {
        for (const hash of hunk.hashes ?? []) strict.add(hash);
        for (const hash of hunk.loose ?? []) loose.add(hash);
      }
      addToIndex(this.strictIndex, file, strict, edit);
      addToIndex(this.looseIndex, file, loose, edit);
    }
  }

  /** Calls `listener` shortly after the record files change on disk. */
  onDidChange(listener: () => void): { dispose(): void } {
    this.listeners.add(listener);
    this.ensureWatching();
    return { dispose: () => this.listeners.delete(listener) };
  }

  dispose(): void {
    this.listeners.clear();
    clearTimeout(this.watchTimer);
    this.watcher?.close();
    this.watcher = undefined;
  }

  // The folder is created by the first hook run, so the watch is retried on
  // each refresh until it succeeds.
  private ensureWatching(): void {
    if (this.watcher || this.listeners.size === 0) return;
    try {
      this.watcher = fs.watch(this.dir, () => {
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => {
          if (this.refresh()) for (const listener of this.listeners) listener();
        }, 100);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = undefined;
      });
      this.watcher.unref();
    } catch {
      this.watcher = undefined;
    }
  }
}
