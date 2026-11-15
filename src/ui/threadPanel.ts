// Webview that renders a session's transcript and scrolls to the tool call
// that wrote a line (docs/SPEC.md, "Thread panel").
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { claudeCode } from '../adapters/claudeCode';
import type { Edit, Turn } from '../store/schema';
import { renderThreadHtml, threadTitle, type ThreadView } from './threadHtml';

export interface ThreadTarget {
  edit: Edit;
  turn?: Turn;
  /** Repo root, to show file paths relative to it. */
  root: string;
}

/** What the webview reported after scrolling: the tool call it looked for and whether it was there. */
export interface Revealed {
  id: string;
  found: boolean;
}

interface OpenPanel {
  panel: vscode.WebviewPanel;
  view: ThreadView;
  transcript?: string;
  revealed: Promise<Revealed>;
}

export class ThreadPanels implements vscode.Disposable {
  /** One panel per session, reused when another line of the same session is opened. */
  private readonly panels = new Map<string, OpenPanel>();
  private readonly media: vscode.Uri;

  constructor(context: vscode.ExtensionContext) {
    this.media = vscode.Uri.joinPath(context.extensionUri, 'media', 'threadPanel');
  }

  /** Opens the thread behind an edit, scrolled to its tool call. */
  show(target: ThreadTarget): OpenPanel | undefined {
    // Transcripts are untrusted content; the panel stays off until the workspace is trusted.
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage('Thread Trace: the thread panel is disabled in untrusted workspaces.');
      return undefined;
    }
    const { edit, turn } = target;
    const transcript = turn?.transcript_path;
    const thread = transcript ? claudeCode.readThread(transcript) : undefined;
    const view: ThreadView = {
      turn,
      edit,
      thread,
      // A subagent's tool calls are in its own transcript, not the session's.
      subagent:
        thread && transcript && edit.agent_id
          ? claudeCode.readThread(claudeCode.subagentTranscriptPath(transcript, edit.session_id, edit.agent_id))
          : undefined,
      target: edit.tool_use_id,
      root: target.root,
      hasTranscript: !!transcript && fs.existsSync(transcript),
    };

    let open = this.panels.get(edit.session_id);
    if (!open) {
      const panel = vscode.window.createWebviewPanel('threadTrace.thread', threadTitle(view), vscode.ViewColumn.Beside, {
        enableScripts: true,
        enableCommandUris: false,
        localResourceRoots: [this.media],
      });
      const created: OpenPanel = { panel, view, transcript, revealed: Promise.resolve({ id: '', found: false }) };
      open = created;
      this.panels.set(edit.session_id, created);
      panel.onDidDispose(() => this.panels.delete(edit.session_id));
      panel.webview.onDidReceiveMessage((message: unknown) => void this.handle(created, message));
    }
    open.view = view;
    open.transcript = transcript;
    open.panel.title = threadTitle(view);
    const webview = open.panel.webview;
    open.revealed = new Promise<Revealed>((resolve) => {
      const listener = webview.onDidReceiveMessage((message: { type?: unknown; id?: unknown; found?: unknown }) => {
        if (message?.type !== 'revealed') return;
        listener.dispose();
        resolve({ id: String(message.id ?? ''), found: message.found === true });
      });
    });
    // A new nonce each time also makes the webview reload when only the target changed.
    webview.html = renderThreadHtml(view, {
      cspSource: webview.cspSource,
      nonce: randomBytes(16).toString('hex'),
      styleUri: webview.asWebviewUri(vscode.Uri.joinPath(this.media, 'panel.css')).toString(),
      scriptUri: webview.asWebviewUri(vscode.Uri.joinPath(this.media, 'panel.js')).toString(),
    });
    open.panel.reveal(undefined, true);
    return open;
  }

  dispose(): void {
    for (const { panel } of [...this.panels.values()]) panel.dispose();
    this.panels.clear();
  }

  // The webview sends an action name and nothing else; what it acts on comes
  // from this side, so a compromised page can't choose a URL or a file.
  private async handle(open: OpenPanel, message: unknown): Promise<void> {
    const type = (message as { type?: unknown } | null)?.type;
    const { turn, thread } = open.view;
    if (type === 'copyPrompt') {
      const first = thread?.items.find((item) => item.kind === 'prompt' && item.origin === 'human' && item.text.trim() !== '');
      const prompt = first?.kind === 'prompt' ? first.text : turn?.prompt;
      if (!prompt) return;
      await vscode.env.clipboard.writeText(prompt);
      vscode.window.setStatusBarMessage('Thread Trace: prompt copied', 2000);
    } else if (type === 'revealTranscript') {
      if (open.transcript) await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(open.transcript));
    } else if (type === 'openWeb') {
      if (turn?.thread_url?.startsWith('https://')) await vscode.env.openExternal(vscode.Uri.parse(turn.thread_url, true));
    }
  }
}
