// Turns (file, line) into an Attribution (docs/SPEC.md, "Resolving a line" and
// "M2 decisions"). Plain Node, no vscode: the caller passes the buffer text.
import { claudeCode } from '../adapters/claudeCode';
import type { AgentAdapter } from '../adapters/types';
import { findRepo, readHead, type RepoInfo } from '../capture/gitDir';
import { blameLines, type BlameLine } from '../git/blame';
import type { Git } from '../git/exec';
import { fileAt, formerPaths, lineHistory } from '../git/log';
import { commitTrailers, hasAgentTrailer, type Trailers } from '../git/trailers';
import { looseHash, splitLines, strictHash } from '../store/hash';
import type { Attribution, CommitInfo, Confidence, Edit, Hunk } from '../store/schema';
import type { TraceStore } from '../store/traceStore';
import { similarity } from './fuzzy';
import { isWeak } from './weakLines';

export interface DocSnapshot {
  /** Repo-relative path, POSIX separators. */
  file: string;
  /** 1-based. */
  line: number;
  /** The whole buffer, as shown on screen (may be unsaved). */
  text: string;
  /** Identifies this exact text, e.g. `${uri}@${document.version}`. Blame is cached while it stays the same. */
  version?: string;
}

/** `exact` needs the line within this many lines of where the edit put it. */
const POSITION_SLACK = 20;
/** An edit may be recorded up to this long after the commit's timestamp. */
const WINDOW_SECONDS = 10 * 60;
const FUZZY_MIN = 0.75;
/** How far to look for a weak line's strong neighbor, and for a tweaked line's original. */
const REGION = 20;
const MAX_BLAME_CACHE = 256;
const MAX_FILE_CACHE = 32;
const MAX_TRAILER_CACHE = 1024;

export interface ResolverOptions {
  /** `threadTrace.blame.detectMoves`: blame with `-M -C`. Read on every blame, so a settings change applies at once. */
  detectMoves?: () => boolean;
}

type Match = { edit: Edit; older: Edit[] };

function newestFirst(a: Edit, b: Edit): number {
  return a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * The edit must have been recorded by the time the line was committed.
 * Uncommitted lines take any edit: bounding them below by HEAD's time would
 * drop an agent line as soon as an unrelated commit lands before it.
 * The later of author and committer time is used, so an edit amended into an
 * older commit still qualifies; a rebase only ever widens the window.
 */
function inWindow(edit: Edit, blame: BlameLine): boolean {
  if (!blame.committed) return true;
  const recorded = Date.parse(edit.ts) / 1000;
  return recorded <= Math.max(blame.authorTime, blame.committerTime) + WINDOW_SECONDS;
}

function nearRecordedPosition(edit: Edit, hash: string, line: number): boolean {
  for (const hunk of edit.hunks) {
    if (hunk.start === undefined) continue;
    for (let i = 0; i < hunk.hashes.length; i++) {
      if (hunk.hashes[i] === hash && Math.abs(hunk.start + i - line) <= POSITION_SLACK) return true;
    }
  }
  return false;
}

/** True when some hunk holds `anchor` and, `offset` lines away from it, `other`. */
function alignedInHunk(hunks: Hunk[], pick: (hunk: Hunk) => string[] | undefined, anchor: string, other: string, offset: number): boolean {
  for (const hunk of hunks) {
    const hashes = pick(hunk);
    if (!hashes) continue;
    for (let i = 0; i < hashes.length; i++) {
      if (hashes[i] === anchor && hashes[i + offset] === other) return true;
    }
  }
  return false;
}

function commitInfo(blame: BlameLine): CommitInfo | undefined {
  if (!blame.committed) return undefined;
  return { sha: blame.sha, author: blame.author, time: blame.authorTime, summary: blame.summary, trailers: {} };
}

export class Resolver {
  private readonly repo: RepoInfo | undefined;
  private blameVersion: string | undefined;
  private readonly blameCache = new Map<string, Promise<BlameLine[]>>();
  private readonly fileCache = new Map<string, Promise<string[] | undefined>>();
  private readonly chainCache = new Map<string, Promise<CommitInfo[]>>();
  /** Trailers by commit sha. Commits never change. */
  private readonly trailerCache = new Map<string, Promise<Trailers>>();
  /** A file's former paths, by `${HEAD}:${file}`. */
  private readonly renameCache = new Map<string, Promise<string[]>>();
  /** The blame each attribution came from, for fetching its commit chain later. */
  private readonly origins = new WeakMap<Attribution, BlameLine>();

  constructor(
    private readonly git: Git,
    private readonly store: TraceStore,
    private readonly adapter: Pick<AgentAdapter, 'modelForEdit'> = claudeCode,
    private readonly options: ResolverOptions = {},
  ) {
    this.repo = findRepo(git.root);
  }

  async resolve(doc: DocSnapshot): Promise<Attribution> {
    this.store.refresh();
    const lines = splitLines(doc.text);
    // The empty line after a final newline isn't a line to git.
    if (doc.line < 1 || doc.line > lines.length) return { line: doc.line, confidence: 'none', history: [] };
    const text = lines[doc.line - 1];
    if (isWeak(text)) return this.withTrailers(await this.resolveWeak(doc, lines));
    const [blame] = await this.blame(doc, doc.line, doc.line, lines.length);
    if (!blame) throw new Error(`no blame for line ${doc.line}`);
    return this.withTrailers(await this.resolveStrong(doc, lines, doc.line, blame));
  }

  /**
   * Reads the agent trailers of the commit the line landed in. When no record
   * matched and the commit message names an agent, that is the attribution,
   * at `commit` confidence: it says which agent, but not which prompt or line.
   */
  private async withTrailers(attribution: Attribution): Promise<Attribution> {
    const { commit } = attribution;
    if (!commit) return attribution;
    let pending = this.trailerCache.get(commit.sha);
    if (!pending) {
      if (this.trailerCache.size >= MAX_TRAILER_CACHE) this.trailerCache.clear();
      pending = commitTrailers(this.git, commit.sha);
      this.trailerCache.set(commit.sha, pending);
    }
    // Filled in place: the attribution was built for this call, and `origins` is keyed by it.
    commit.trailers = await pending;
    if (attribution.confidence === 'none' && hasAgentTrailer(commit.trailers)) attribution.confidence = 'commit';
    return attribution;
  }

  /**
   * Adds the line's older commits to `history`. Separate from `resolve`
   * because `git log -L` is slow; the caller runs it after showing the result.
   */
  async withCommitChain(attribution: Attribution): Promise<Attribution> {
    const blame = this.origins.get(attribution);
    if (!blame?.committed) return attribution;
    const key = `${blame.sha}:${blame.origPath}:${blame.origLine}`;
    let chain = this.chainCache.get(key);
    if (!chain) {
      chain = lineHistory(this.git, blame.sha, blame.origPath, blame.origLine);
      this.chainCache.set(key, chain);
    }
    const older = (await chain).filter((commit) => commit.sha !== blame.sha);
    if (older.length === 0) return attribution;
    const commits: Attribution[] = older.map((commit) => ({
      line: attribution.line,
      confidence: 'none',
      commit,
      history: [],
    }));
    const expanded = { ...attribution, history: [...attribution.history, ...commits] };
    this.origins.set(expanded, blame);
    return expanded;
  }

  private async resolveStrong(doc: DocSnapshot, lines: string[], line: number, blame: BlameLine): Promise<Attribution> {
    const text = lines[line - 1];
    const hash = strictHash(text);
    let paths = [...new Set([doc.file, blame.origPath])];

    let strict = this.candidates(paths, hash, blame, 'strict');
    if (!strict) {
      // The record may be under a name the file had before. `git log --follow`
      // is only run on a miss, to keep it off the common path.
      const former = await this.formerPaths(doc.file);
      if (former.some((path) => !paths.includes(path))) {
        paths = [...new Set([...paths, ...former])];
        strict = this.candidates(paths, hash, blame, 'strict');
      }
    }
    if (strict) {
      const confidence = nearRecordedPosition(strict.edit, hash, line) ? 'exact' : 'likely';
      return this.attribution(line, confidence, blame, strict);
    }
    // Same text apart from whitespace, e.g. after a formatter re-indented it.
    const loose = this.candidates(paths, looseHash(text), blame, 'loose');
    if (loose) return this.attribution(line, 'modified', blame, loose);

    const fuzzy = await this.fuzzyMatch(doc, lines, line, blame, paths);
    if (fuzzy) return this.attribution(line, 'modified', blame, fuzzy);

    return this.attribution(line, 'none', blame);
  }

  /**
   * A weak line (`}`, blank, `else`) says nothing by itself. It takes its
   * nearest strong neighbor's attribution, but only when both lines came in
   * with the same commit and the edit's hunk holds the two lines the same
   * distance apart as they are now. A `}` typed by a human fails that.
   */
  private async resolveWeak(doc: DocSnapshot, lines: string[]): Promise<Attribution> {
    const line = doc.line;
    const from = Math.max(1, line - REGION);
    const to = Math.min(lines.length, line + REGION);
    const blamed = await this.blame(doc, from, to, lines.length);
    const at = (n: number) => blamed.find((entry) => entry.line === n);
    const own = at(line);
    if (!own) throw new Error(`no blame for line ${line}`);
    const text = lines[line - 1];

    for (const direction of [-1, 1]) {
      // The nearest strong line on this side.
      let neighbor = line + direction;
      while (neighbor >= from && neighbor <= to && isWeak(lines[neighbor - 1] ?? '')) neighbor += direction;
      const neighborBlame = neighbor >= from && neighbor <= to ? at(neighbor) : undefined;
      if (!neighborBlame || neighborBlame.sha !== own.sha) continue;

      const found = await this.resolveStrong(doc, lines, neighbor, neighborBlame);
      if (!found.edit || found.confidence === 'none') continue;
      const neighborText = lines[neighbor - 1];
      const offset = line - neighbor;
      const inherits =
        alignedInHunk(found.edit.hunks, (hunk) => hunk.hashes, strictHash(neighborText), strictHash(text), offset) ||
        (found.confidence === 'modified' &&
          alignedInHunk(found.edit.hunks, (hunk) => hunk.loose, looseHash(neighborText), looseHash(text), offset));
      if (!inherits) continue;

      const inherited: Attribution = {
        ...found,
        line,
        commit: commitInfo(own),
        history: found.history.map((entry) => ({ ...entry, line })),
      };
      this.origins.set(inherited, own);
      return inherited;
    }
    return this.attribution(line, 'none', own);
  }

  /** The newest edit in the window that wrote `hash` to one of `paths`, plus the older ones. */
  private candidates(paths: string[], hash: string, blame: BlameLine, index: 'strict' | 'loose'): Match | undefined {
    const found = new Set<Edit>();
    for (const path of paths) {
      for (const edit of this.store[index](path, hash)) if (inWindow(edit, blame)) found.add(edit);
    }
    if (found.size === 0) return undefined;
    const [edit, ...older] = [...found].sort(newestFirst);
    return { edit, older };
  }

  /**
   * A human changed the line after an agent wrote it. Records hold hashes, not
   * text, so the agent's wording is read from git: the file as it was before
   * the blamed commit (or at HEAD, for an uncommitted change). A line there
   * that an agent wrote, that is gone from the buffer now, and that is close
   * enough to the current text is the original.
   */
  private async fuzzyMatch(doc: DocSnapshot, lines: string[], line: number, blame: BlameLine, known: string[]): Promise<Match | undefined> {
    const head = this.repo ? readHead(this.repo).head : '';
    const before = blame.committed ? blame.previous : head ? { sha: head, path: doc.file } : undefined;
    if (!before) return undefined;
    const old = await this.fileLines(before.sha, before.path);
    if (!old) return undefined;

    const stillPresent = new Set<string>();
    for (let n = Math.max(1, line - REGION); n <= Math.min(lines.length, line + REGION); n++) {
      stillPresent.add(strictHash(lines[n - 1]));
    }
    const text = lines[line - 1];
    const paths = [...new Set([...known, before.path])];
    const center = blame.committed ? blame.origLine : line;
    let best: { match: Match; score: number; distance: number } | undefined;
    for (let n = Math.max(1, center - REGION); n <= Math.min(old.length, center + REGION); n++) {
      const oldText = old[n - 1];
      if (isWeak(oldText)) continue;
      const score = similarity(text, oldText);
      if (score < FUZZY_MIN) continue;
      const hash = strictHash(oldText);
      if (stillPresent.has(hash)) continue;
      const match = this.candidates(paths, hash, blame, 'strict');
      if (!match) continue;
      const distance = Math.abs(n - center);
      if (!best || score > best.score || (score === best.score && distance < best.distance)) {
        best = { match, score, distance };
      }
    }
    return best?.match;
  }

  private attribution(line: number, confidence: Confidence, blame: BlameLine, match?: Match): Attribution {
    const entry = (edit: Edit): Pick<Attribution, 'edit' | 'turn'> => {
      const turn = this.store.turn(edit.turn_id);
      // The hook's model is a guess (docs/SPEC.md, "M1 decisions"); the
      // transcript, while it exists, has the real one.
      const model = this.adapter.modelForEdit({ ...edit, transcript_path: turn?.transcript_path });
      return { edit: model && model !== edit.model ? { ...edit, model } : edit, turn };
    };
    const attribution: Attribution = {
      line,
      confidence,
      ...(match ? entry(match.edit) : {}),
      commit: commitInfo(blame),
      history: (match?.older ?? []).map((edit) => ({ line, confidence, ...entry(edit), history: [] })),
    };
    this.origins.set(attribution, blame);
    return attribution;
  }

  /** Paths the file had before it was renamed. Cached until HEAD moves. */
  private formerPaths(file: string): Promise<string[]> {
    const key = `${this.repo ? readHead(this.repo).head : ''}:${file}`;
    let pending = this.renameCache.get(key);
    if (!pending) {
      if (this.renameCache.size >= MAX_FILE_CACHE) this.renameCache.clear();
      pending = formerPaths(this.git, file);
      this.renameCache.set(key, pending);
    }
    return pending;
  }

  /** Blame for lines `from`..`to` of a buffer with `total` lines. */
  private async blame(doc: DocSnapshot, from: number, to: number, total: number): Promise<BlameLine[]> {
    const detectMoves = this.options.detectMoves?.() ?? false;
    if (!detectMoves) return this.blameRange(doc, from, to, false);
    // git only recognizes a move when the moved text is long enough (40
    // letters and digits across files), and it looks only at the lines it was
    // asked to blame. One line is rarely enough, so its neighbors are blamed
    // with it.
    const start = Math.max(1, from - REGION);
    const end = Math.min(total, to + REGION);
    const region = await this.blameRange(doc, start, end, true);
    return region.filter((entry) => entry.line >= from && entry.line <= to);
  }

  private blameRange(doc: DocSnapshot, from: number, to: number, detectMoves: boolean): Promise<BlameLine[]> {
    if (doc.version === undefined) return blameLines(this.git, doc.file, from, to, doc.text, detectMoves);
    const version = `${doc.version}${detectMoves ? ' -M -C' : ''}`;
    if (version !== this.blameVersion || this.blameCache.size >= MAX_BLAME_CACHE) {
      this.blameCache.clear();
      this.blameVersion = version;
    }
    const key = `${from}-${to}`;
    let pending = this.blameCache.get(key);
    if (!pending) {
      pending = blameLines(this.git, doc.file, from, to, doc.text, detectMoves);
      this.blameCache.set(key, pending);
      // A failed blame shouldn't stick.
      pending.catch(() => this.blameCache.delete(key));
    }
    return pending;
  }

  /** Lines of a file at a commit. Commits never change, so entries never go stale. */
  private fileLines(sha: string, path: string): Promise<string[] | undefined> {
    const key = `${sha}:${path}`;
    let pending = this.fileCache.get(key);
    if (!pending) {
      if (this.fileCache.size >= MAX_FILE_CACHE) this.fileCache.clear();
      pending = fileAt(this.git, sha, path).then((text) => (text === undefined ? undefined : splitLines(text)));
      this.fileCache.set(key, pending);
    }
    return pending;
  }
}
