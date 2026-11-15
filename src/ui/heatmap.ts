// Whole-file attribution for the visible editors, and the heatmap drawn from
// it: a thin colored bar on each agent-written line, one color per model
// (docs/SPEC.md, "Other surfaces" and "M5 decisions").
import * as vscode from 'vscode';
import type { GitService } from '../git/gitService';
import type { Attribution } from '../store/schema';
import { ColorSlots, heatmapBarSvg, ownerOf, summarize, type FileSummary, type OwnerKind } from './fileSummary';

/** A whole-file blame is one git call over the buffer; skip files where that would be slow. */
const MAX_LINES = 10_000;
const MAX_DOCUMENT_CHARS = 5_000_000;
const DEBOUNCE_MS = 250;

/** One color per model, in the order models are first seen. Hex, so the legend can draw the same swatch. */
export const PALETTE: readonly { light: string; dark: string }[] = [
  { light: '#1a73c8', dark: '#5aa9f0' },
  { light: '#8250df', dark: '#b392f0' },
  { light: '#c4690a', dark: '#f0a04b' },
  { light: '#0f8a7e', dark: '#4ec9b0' },
  { light: '#c2378b', dark: '#f47fbf' },
  { light: '#6a8a00', dark: '#b5cc4b' },
];

function bar(color: string, kind: OwnerKind): vscode.Uri {
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(heatmapBarSvg(color, kind)).toString('base64')}`);
}

export interface FileScan {
  uri: vscode.Uri;
  version: number;
  /** Entry `i` is line `i`, 0-based as in the editor. */
  attributions: Attribution[];
  summary: FileSummary;
}

function heatmapEnabled(): boolean {
  return vscode.workspace.getConfiguration('threadTrace').get<boolean>('heatmap.enabled', false);
}

export class Heatmap implements vscode.Disposable {
  /** Shared with the legend, so a model has the same color there. */
  readonly colors = new ColorSlots(PALETTE.length);
  private readonly decorations = new Map<string, vscode.TextEditorDecorationType>();
  private readonly scans = new Map<string, FileScan>();
  private readonly pending = new Map<string, { version: number; scan: Promise<FileScan | undefined> }>();
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when a visible file's attribution was recomputed or dropped. */
  readonly onDidChange = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [this.changed];
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly git: GitService) {
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.window.onDidChangeActiveTextEditor(() => this.changed.fire()),
      // Per the spec the file is blamed on open and on save, not on every keystroke.
      // Decorations move with the text in between.
      vscode.workspace.onDidSaveTextDocument(() => this.schedule()),
      vscode.workspace.onDidCloseTextDocument((document) => this.scans.delete(document.uri.toString())),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('threadTrace.blame')) this.scans.clear();
        if (event.affectsConfiguration('threadTrace.heatmap') || event.affectsConfiguration('threadTrace.blame')) this.schedule();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.schedule()),
      git.onDidChangeRecords(() => {
        this.scans.clear();
        this.schedule();
      }),
    );
    this.schedule();
  }

  /** The last scan of a document, when it is still the text on screen or the last saved text. */
  scanOf(document: vscode.TextDocument): FileScan | undefined {
    return this.scans.get(document.uri.toString());
  }

  /** Resolves every line of a document. Undefined when it can't be attributed (untrusted, not in a repo, too large). */
  scan(document: vscode.TextDocument): Promise<FileScan | undefined> {
    const key = document.uri.toString();
    const cached = this.scans.get(key);
    if (cached?.version === document.version) return Promise.resolve(cached);
    const running = this.pending.get(key);
    if (running?.version === document.version) return running.scan;
    const version = document.version;
    const scan = this.compute(document).finally(() => {
      if (this.pending.get(key)?.scan === scan) this.pending.delete(key);
    });
    this.pending.set(key, { version, scan });
    return scan;
  }

  /** How many lines of the editor's file the heatmap would color. */
  coloredLines(scan: FileScan): number {
    return scan.attributions.filter((attribution) => ownerOf(attribution)).length;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    for (const decoration of this.decorations.values()) decoration.dispose();
    for (const disposable of this.disposables) disposable.dispose();
  }

  private async compute(document: vscode.TextDocument): Promise<FileScan | undefined> {
    // Blame runs git in the repo, so nothing is scanned until the workspace is trusted.
    if (!vscode.workspace.isTrusted || document.uri.scheme !== 'file') return undefined;
    if (document.lineCount > MAX_LINES) return undefined;
    const text = document.getText();
    if (text.length > MAX_DOCUMENT_CHARS) return undefined;
    const version = document.version;
    const found = await this.git.forFile(document.uri.fsPath);
    if (!found) return undefined;
    const attributions = await found.repo.resolver.resolveFile({
      file: found.file,
      text,
      version: `${document.uri.toString()}@${version}`,
    });
    const lines = attributions.map((_, index) => document.lineAt(Math.min(index, document.lineCount - 1)).text);
    const scan: FileScan = { uri: document.uri, version, attributions, summary: summarize(attributions, lines) };
    // The text may have changed while git ran; the scan then describes the saved text, which is still worth showing.
    if (!this.disposed && !document.isClosed) this.scans.set(document.uri.toString(), scan);
    return scan;
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), DEBOUNCE_MS);
  }

  private async update(): Promise<void> {
    const editors = vscode.window.visibleTextEditors;
    await Promise.all(
      editors.map(async (editor) => {
        try {
          const scan = await this.scan(editor.document);
          if (!scan) this.scans.delete(editor.document.uri.toString());
        } catch (error) {
          this.scans.delete(editor.document.uri.toString());
          console.warn('Thread Trace: could not attribute file', error);
        }
      }),
    );
    if (this.disposed) return;
    for (const editor of vscode.window.visibleTextEditors) this.paint(editor);
    this.changed.fire();
  }

  private paint(editor: vscode.TextEditor): void {
    const scan = heatmapEnabled() ? this.scans.get(editor.document.uri.toString()) : undefined;
    const ranges = new Map<string, vscode.Range[]>();
    if (scan) {
      const last = editor.document.lineCount - 1;
      scan.attributions.forEach((attribution, line) => {
        const owner = ownerOf(attribution);
        if (!owner || line > last) return;
        const key = `${this.colors.of(owner.label)}:${owner.kind}`;
        this.decoration(key, this.colors.of(owner.label), owner.kind);
        const list = ranges.get(key);
        const range = new vscode.Range(line, 0, line, 0);
        if (list) list.push(range);
        else ranges.set(key, [range]);
      });
    }
    // Every type is set, so lines that lost their color are cleared.
    for (const [key, decoration] of this.decorations) editor.setDecorations(decoration, ranges.get(key) ?? []);
  }

  private decoration(key: string, slot: number, kind: OwnerKind): vscode.TextEditorDecorationType {
    let decoration = this.decorations.get(key);
    if (!decoration) {
      const color = PALETTE[slot];
      decoration = vscode.window.createTextEditorDecorationType({
        isWholeLine: true,
        gutterIconSize: '100% 100%',
        overviewRulerLane: vscode.OverviewRulerLane.Left,
        light: { gutterIconPath: bar(color.light, kind), overviewRulerColor: color.light },
        dark: { gutterIconPath: bar(color.dark, kind), overviewRulerColor: color.dark },
      });
      this.decorations.set(key, decoration);
    }
    return decoration;
  }
}
