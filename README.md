# Thread Trace — Agent Blame

Hover a line to see which agent, model and prompt wrote it.

Thread Trace is `git blame` for code written by AI agents. When Claude Code edits a file, Thread Trace records which session, prompt and model made each change. In VS Code you can then see, for any line, the conversation that produced it, and open the transcript at the exact tool call that wrote it.

Everything stays on your machine. Nothing is uploaded.

## Features

- **Line annotation.** The cursor line ends with who wrote it: `✦ Claude Opus 5.5 · 2h ago · 1 thread` for an agent line, the author and date for a human one.
- **Hover card.** Hover the annotation for the full history of the line: the prompt, model and confidence of each agent edit, and the commits it went through, newest first. Copy the prompt, open the diff, or open the thread.
- **Thread panel.** Opens the session's transcript scrolled to the tool call that wrote the line, with the edit shown as a diff. Subagent edits open in the subagent's own transcript.
- **Backfill.** Code written before you installed Thread Trace can be attributed from the Claude Code transcripts already on disk.
- **Commit trailers.** Commits with a `Claude-Session:` link or a Claude `Co-Authored-By:` trailer are attributed even without local records, which covers work from cloud sessions.
- **Heatmap.** An optional colored bar on every agent-written line, one color per model. The status bar shows how much of the file agents wrote (`✦ 62% agent`); click it for a legend.
- **Agent Threads view.** Lists the sessions that edited the current file, in the Explorer.
- **Agent Trace export.** Writes the attribution for HEAD to `.agent-trace/traces.jsonl` in the [Agent Trace](https://agent-trace.dev) format, after showing you a preview.

## Honest confidence

Every attribution says how sure it is. Nothing is guessed silently.

| Label | Meaning |
| --- | --- |
| `exact` | The line is exactly what the agent wrote, close to where it wrote it. |
| `likely` | The line matches what the agent wrote, but it has moved, or the record has no position. |
| `modified` | The agent wrote it and someone edited it afterwards. The card shows the human commit first. |
| `commit` | Known only from the commit message's trailers, not from a local record. |
| none | No agent record matches. Plain blame is shown. |

## Requirements

- **[Claude Code](https://claude.com/claude-code)**, the only agent supported so far.
- **Node.js 18 or later** on the `PATH` that Claude Code runs hooks with. The capture hook is a small Node script. Claude Code's native installer doesn't include Node, so check `node --version` in a terminal.
- **Git.** Files must be in a git repository.
- VS Code 1.90 or later.

## Getting started

1. Open a git repository and run **Thread Trace: Install Agent Hooks** from the Command Palette.
2. Choose where to install:
   - **This project** writes `.claude/settings.local.json`, which stays on this machine and isn't committed.
   - **All projects** writes `~/.claude/settings.json`.

   Thread Trace shows the exact change to the settings file in a diff and writes nothing until you confirm.
3. Start a new Claude Code session and let it edit some files. Put the cursor on an edited line and hover the annotation at the end of it.
4. To attribute older work, run **Thread Trace: Backfill from Transcripts**. It can be run any number of times; edits already recorded are skipped.

To remove the hooks, run **Thread Trace: Uninstall Agent Hooks**. It also shows the diff first.

## Commands

| Command | What it does |
| --- | --- |
| Thread Trace: Install Agent Hooks | Adds the capture hooks to a Claude Code settings file, after showing the diff. |
| Thread Trace: Uninstall Agent Hooks | Removes them, after showing the diff. |
| Thread Trace: Show Thread for Line | Opens the thread panel for the cursor line. |
| Thread Trace: Copy Prompt for Line | Copies the prompt behind the cursor line. |
| Thread Trace: Open Thread on claude.ai | Opens the session on claude.ai, when its link is known. |
| Thread Trace: Backfill from Transcripts | Imports attribution from Claude Code transcripts on disk. |
| Thread Trace: Toggle Line Annotation | Shows or hides the end-of-line annotation. |
| Thread Trace: Toggle Agent Heatmap | Shows or hides the heatmap. |
| Thread Trace: Show Agent Summary for File | Shows the legend: lines per model for the current file. |
| Thread Trace: Export Agent Trace | Previews, then writes, `.agent-trace/traces.jsonl` for HEAD. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `threadTrace.annotation.enabled` | `true` | Shows the end-of-line annotation. |
| `threadTrace.hover.mode` | `"annotation"` | `annotation` shows the card only on the annotation. `anywhere` also adds a one-line attribution to every hover. |
| `threadTrace.heatmap.enabled` | `false` | Shows the heatmap. Solid bars are `exact` or `likely`, dashed are `modified`, dotted are `commit`. |
| `threadTrace.blame.detectMoves` | `false` | Follows lines moved or copied from other files (`git blame -M -C`). Slower on large files. |
| `threadTrace.capture.prompt` | `"full"` | How much of each prompt is stored: `full`, `firstLine` or `none`. |
| `threadTrace.capture.redact` | `[]` | Extra regular expressions to redact from prompts, on top of the built-in ones. |

The two `capture` settings can only be set in your user settings, never by a workspace, so a repository you open can't change what is recorded.

## Privacy

- **Records stay local.** They are written to `.git/thread-trace/` in each repository, which git never commits. Transcripts are referenced by path, never copied.
- **Prompts are redacted before they are stored.** Built-in patterns remove API keys, tokens, `password=`-style pairs and private keys. Add your own with `threadTrace.capture.redact`, or store less with `threadTrace.capture.prompt`.
- **Sharing is explicit.** The only way records leave your machine is **Export Agent Trace**, which previews the file before writing it. The export holds paths, line ranges, model names, session ids and session links. It never includes prompts, transcript paths or working directories.

## Security

- **Untrusted workspaces:** installing hooks, backfill, the thread panel and everything that runs git are turned off.
- **The hook** reads its input as JSON and nothing else. It never prints output, never blocks Claude Code and always exits successfully, even when something goes wrong. It writes only under `.git/thread-trace/` and `~/.thread-trace/`.
- **Transcripts, prompts and commit messages are shown as plain text**, never rendered as Markdown or HTML. The thread panel loads no remote content.
- **Settings files are never changed without your confirmation.**

## Limitations

- Only Claude Code is supported. Other agents may come later.
- Records are per machine. Teammates don't see each other's threads, except through commit trailers or an export.
- Cloud sessions don't run your local hooks, so their work shows `commit` confidence at best, from the commit's trailers.
- After heavy hand edits a line is reported as `modified` or not attributed at all, rather than guessed.
- Windows hasn't been tested yet.

## How it works

Install adds two Claude Code hooks: one when you submit a prompt, and one after each `Edit` or `Write`. They run a small script (`~/.thread-trace/bin/tt-capture.js`) that appends a record of the prompt, and of the lines each edit wrote with their hashes, to `.git/thread-trace/`. When you hover a line, Thread Trace runs `git blame`, finds the commit and the records that match the line's content, and grades how well they match. The script is updated automatically when the extension updates.

## License

[MIT](LICENSE)
