// Status bar summary for the active file (`✦ 62% agent`) and the legend it
// opens (docs/SPEC.md, "Other surfaces").
import * as vscode from 'vscode';
import { legendRows, statusText, type FileSummary } from './fileSummary';
import { PALETTE, type Heatmap } from './heatmap';

function swatch(color: string): vscode.Uri {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect x="5" y="1" width="4" height="14" rx="1" fill="${color}"/></svg>`;
  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`);
}

interface LegendItem extends vscode.QuickPickItem {
  run?: () => Thenable<unknown>;
}

export class StatusSummary implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('threadTrace.summary', vscode.StatusBarAlignment.Right, 100);
  private readonly subscription: vscode.Disposable;

  constructor(private readonly heatmap: Heatmap) {
    this.item.name = 'Thread Trace';
    this.item.command = 'threadTrace.showLegend';
    this.subscription = heatmap.onDidChange(() => this.update());
    this.update();
  }

  /** The active file's summary, when it has been attributed. */
  private summary(): FileSummary | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor ? this.heatmap.scanOf(editor.document)?.summary : undefined;
  }

  private update(): void {
    const summary = this.summary();
    // A file no agent touched gets no item; an empty "0% agent" on every file is noise.
    if (!summary || summary.agent === 0) {
      this.item.hide();
      return;
    }
    this.item.text = statusText(summary);
    this.item.tooltip = `Thread Trace: ${summary.agent} of ${summary.total} lines in this file were written by an agent. Click for the breakdown.`;
    this.item.show();
  }

  /** `threadTrace.showLegend`: which color is which model, and how many lines each wrote. */
  async showLegend(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const scan = editor ? await this.heatmap.scan(editor.document) : undefined;
    const on = vscode.workspace.getConfiguration('threadTrace').get<boolean>('heatmap.enabled', false);
    const items: LegendItem[] = [];
    if (scan) {
      for (const row of legendRows(scan.summary)) {
        const color = row.owner === undefined ? undefined : PALETTE[this.heatmap.colors.of(row.owner)];
        items.push({
          label: row.label,
          description: row.description,
          iconPath: color ? { light: swatch(color.light), dark: swatch(color.dark) } : new vscode.ThemeIcon('person'),
        });
      }
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({
      label: on ? '$(eye-closed) Hide the heatmap' : '$(eye) Show the heatmap',
      description: 'A colored bar on each agent-written line',
      run: () => vscode.commands.executeCommand('threadTrace.toggleHeatmap'),
    });
    const picked = await vscode.window.showQuickPick(items, {
      title: scan ? `Thread Trace: ${statusText(scan.summary).replace('✦ ', '')} in this file` : 'Thread Trace',
      placeHolder: scan ? 'Lines by the model that wrote them' : 'This file can’t be attributed (not in a trusted git repository, or too large)',
    });
    await picked?.run?.();
  }

  dispose(): void {
    this.subscription.dispose();
    this.item.dispose();
  }
}
