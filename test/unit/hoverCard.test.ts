import { describe, expect, it } from 'vitest';
import type { Attribution, CommitInfo, Edit, Turn } from '../../src/store/schema';
import { annotationText, compactLine, escapeText, HOVER_COMMANDS, prettyModel, relativeTime, renderCard } from '../../src/ui/hoverCard';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// Noon local time, so "Today" doesn't depend on the machine's time zone.
const NOW = new Date(2026, 10, 15, 12, 0, 0).getTime();

function edit(overrides: Partial<Edit> = {}): Edit {
  return {
    v: 1,
    id: 'E1',
    turn_id: 's1:p1',
    session_id: 's1',
    tool: 'Edit',
    model: 'claude-opus-5-5',
    file: 'src/a.ts',
    ts: new Date(NOW - 2 * HOUR).toISOString(),
    hunks: [],
    base_head: '',
    source: 'hook',
    ...overrides,
  };
}

function turn(overrides: Partial<Turn> = {}): Turn {
  return {
    v: 1,
    id: 's1:p1',
    agent: { name: 'claude-code' },
    session_id: 's1',
    prompt: 'Add an action to expand child threads',
    origin: 'human',
    ts: new Date(NOW - 2 * HOUR).toISOString(),
    cwd: '/repo',
    git: { head: '' },
    source: 'hook',
    ...overrides,
  };
}

const commit: CommitInfo = {
  sha: 'd574e59aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  author: 'Julian',
  time: (NOW - HOUR) / 1000,
  summary: 'Add Expand Child Threads action',
  trailers: {},
};

function attribution(overrides: Partial<Attribution> = {}): Attribution {
  return { line: 3141, confidence: 'exact', edit: edit(), turn: turn(), commit, history: [], ...overrides };
}

/** Every command id a link in the card would run. */
function linkedCommands(markdown: string): string[] {
  return [...markdown.matchAll(/command:([A-Za-z0-9_.]+)/g)].map((match) => match[1]);
}

describe('prettyModel', () => {
  it.each([
    ['claude-opus-5-5', 'Claude Opus 5.5'],
    ['claude-fable-5-2', 'Claude Fable 5.2'],
    ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
    ['claude-opus-5-5[1m]', 'Claude Opus 5.5'],
    ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
    ['gpt-5', 'gpt-5'],
  ])('%s → %s', (id, pretty) => expect(prettyModel(id)).toBe(pretty));
  it('passes undefined through', () => expect(prettyModel(undefined)).toBeUndefined());
});

describe('relativeTime', () => {
  it.each([
    [30_000, 'just now'],
    [5 * MINUTE, '5m ago'],
    [2 * HOUR, '2h ago'],
    [30 * HOUR, 'Yesterday'],
    [3 * DAY, '3 days ago'],
    [70 * DAY, '2 months ago'],
    [800 * DAY, '2 years ago'],
  ])('%d ms ago → %s', (elapsed, text) => expect(relativeTime(NOW - elapsed, NOW)).toBe(text));
});

describe('annotationText', () => {
  it('names the model for an agent line', () => {
    expect(annotationText(attribution(), NOW)).toBe('✦ Claude Opus 5.5 · 2h ago · 1 thread');
    expect(annotationText(attribution({ confidence: 'likely', commit: undefined }), NOW)).toBe('✦ Claude Opus 5.5 · 2h ago · 1 thread');
  });
  it('names the committer for a human line with agent history', () => {
    const modified = attribution({ confidence: 'modified', commit: { ...commit, time: (NOW - 30 * HOUR) / 1000 } });
    expect(annotationText(modified, NOW)).toBe('Julian, Yesterday · 1 thread');
  });
  it('shows plain blame for a human-only line', () => {
    const human = attribution({ confidence: 'none', edit: undefined, turn: undefined });
    expect(annotationText(human, NOW)).toBe('Julian, 1h ago');
    expect(annotationText({ ...human, commit: undefined }, NOW)).toBe('Not committed yet');
  });
  it('falls back when the model is unknown', () => {
    expect(annotationText(attribution({ edit: edit({ model: undefined }) }), NOW)).toBe('✦ Agent · 2h ago · 1 thread');
  });
});

describe('renderCard', () => {
  it('shows the thread, then the commit it landed in, with totals', () => {
    const { markdown } = renderCard(attribution(), { now: NOW, file: 'src/a.ts' });
    expect(markdown).toContain('**Line 3141**');
    expect(markdown).toContain('*Today*');
    expect(markdown).toContain('**Claude Opus 5\\.5** · claude\\-code · 2h ago · $(check) exact');
    expect(markdown).toContain('> Add an action to expand child threads');
    expect(markdown).toContain('**Add Expand Child Threads action**');
    expect(markdown).toContain('Julian · 1h ago · `d574e59`');
    expect(markdown.indexOf('Claude Opus')).toBeLessThan(markdown.indexOf('Add Expand Child'));
    expect(markdown).toContain('1 thread · 1 commit');
    expect(markdown).toContain('Copy prompt');
    expect(markdown).toContain('Diff');
    expect(markdown).not.toContain('Open on claude.ai');
  });

  it('shows two prompt lines and marks the rest as cut', () => {
    const long = turn({ prompt: 'first line\n\nsecond line\nthird line' });
    const { markdown } = renderCard(attribution({ turn: long }), { now: NOW });
    expect(markdown).toContain('> first line  \n> second line…');
    expect(markdown).not.toContain('third line');
  });

  it('explains a missing, empty or agent-submitted prompt instead of quoting it', () => {
    expect(renderCard(attribution({ turn: undefined }), { now: NOW }).markdown).toContain('No prompt was recorded');
    expect(renderCard(attribution({ turn: turn({ prompt: '' }) }), { now: NOW }).markdown).toContain('was not stored');
    const agent = renderCard(attribution({ turn: turn({ prompt: '', origin: 'agent' }) }), { now: NOW }).markdown;
    expect(agent).toContain('Started by the agent itself');
    expect(agent).not.toContain('Copy prompt');
  });

  it('groups older history under its own heading, newest first', () => {
    const history: Attribution[] = [
      { line: 1, confidence: 'none', commit: { ...commit, sha: 'b'.repeat(40), summary: 'Ancient commit', time: (NOW - 40 * DAY) / 1000 }, history: [] },
      { line: 1, confidence: 'exact', edit: edit({ id: 'E0', session_id: 's0', ts: new Date(NOW - 3 * DAY).toISOString() }), turn: turn({ id: 's0:p0', prompt: 'Earlier attempt' }), history: [] },
    ];
    const { markdown } = renderCard(attribution({ history }), { now: NOW });
    const order = ['*Today*', '*This week*', 'Earlier attempt', '*Older*', 'Ancient commit'].map((text) => markdown.indexOf(text));
    expect(order.every((index) => index !== -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(markdown).toContain('2 threads · 2 commits');
  });

  it('filters to threads or commits', () => {
    const threads = renderCard(attribution(), { now: NOW, filter: 'threads' }).markdown;
    expect(threads).toContain('Claude Opus');
    expect(threads).not.toContain('Add Expand Child');
    const commits = renderCard(attribution(), { now: NOW, filter: 'commits' }).markdown;
    expect(commits).not.toContain('Claude Opus');
    expect(commits).toContain('Add Expand Child');
    const none = renderCard(attribution({ edit: undefined, turn: undefined, confidence: 'none' }), { now: NOW, filter: 'threads' });
    expect(none.markdown).toContain('No threads for this line');
  });

  it('marks subagent edits and offers the web link only for https thread URLs', () => {
    const web = renderCard(attribution({ edit: edit({ agent_id: 'a1' }), turn: turn({ thread_url: 'https://claude.ai/code/session_1' }) }), { now: NOW });
    expect(web.markdown).toContain('claude\\-code subagent');
    expect(web.markdown).toContain('Open on claude.ai');
    const bad = renderCard(attribution({ turn: turn({ thread_url: 'javascript:alert(1)' }) }), { now: NOW });
    expect(bad.markdown).not.toContain('Open on claude.ai');
  });
});

describe('commit confidence', () => {
  const session = 'https://claude.ai/code/session_01AbCdEfGh';
  const agentCommit: CommitInfo = { ...commit, trailers: { session, coAuthor: 'Claude Opus 5.5' } };
  const trailerOnly = (trailers = agentCommit.trailers) =>
    attribution({ confidence: 'commit', edit: undefined, turn: undefined, commit: { ...commit, trailers } });

  it('names the agent from the commit message in the annotation', () => {
    expect(annotationText(trailerOnly(), NOW)).toBe('✦ Claude Opus 5.5 · 1h ago');
    expect(annotationText(trailerOnly({ session }), NOW)).toBe('✦ Claude · 1h ago');
  });

  it('says where the attribution comes from and links the session by sha', () => {
    const { markdown } = renderCard(trailerOnly(), { now: NOW, file: 'src/a.ts' });
    expect(markdown).toContain('Co\\-authored by **Claude Opus 5\\.5** · **$(git-commit) commit** · *from the commit message; no prompt or line record on this machine*');
    expect(markdown).toContain(`[Open on claude.ai](command:threadTrace.openCommitSession?${encodeURIComponent(JSON.stringify([commit.sha]))} `);
    expect(markdown).not.toContain(session);
    expect(markdown).toContain('1 commit');
    expect(markdown).not.toContain('thread ·');
  });

  it('describes a commit with only the session trailer', () => {
    const { markdown } = renderCard(trailerOnly({ session }), { now: NOW });
    expect(markdown).toContain('Made in a Claude session');
  });

  it('mentions the co-author on a commit under a recorded thread, without the commit badge', () => {
    const { markdown } = renderCard(attribution({ commit: agentCommit }), { now: NOW });
    expect(markdown).toContain('Co\\-authored by **Claude Opus 5\\.5**  ');
    expect(markdown).not.toContain('$(git-commit) commit**');
    expect(markdown).toContain('Open on claude.ai');
  });

  it('offers no session link without a session trailer', () => {
    const { markdown } = renderCard(trailerOnly({ coAuthor: 'Claude Opus 5.5' }), { now: NOW });
    expect(markdown).not.toContain('openCommitSession');
  });
});

describe('compactLine', () => {
  it('is the annotation text, escaped, with the thread link', () => {
    const { markdown, enabledCommands } = compactLine(attribution(), NOW);
    expect(markdown).toBe(
      `✦ Claude Opus 5\\.5 · 2h ago · 1 thread · [Open thread](command:threadTrace.showThreadForLine?${encodeURIComponent(JSON.stringify(['E1']))} "Open the conversation at this edit")`,
    );
    expect(markdown).not.toContain('\n');
    expect(enabledCommands).toEqual([...HOVER_COMMANDS]);
  });

  it('is plain blame for a human line, and escapes the author', () => {
    const human = attribution({ confidence: 'none', edit: undefined, turn: undefined, commit: { ...commit, author: '[x](command:evil) $(zap)' } });
    const { markdown } = compactLine(human, NOW);
    expect(markdown).not.toContain('](command:');
    expect(markdown).not.toContain('$(zap)');
    expect(linkedCommands(markdown).every((id) => id === 'evil')).toBe(true);
  });
});

// Acceptance test 10, the hover half: nothing from a record can add a link or markup.
describe('10: safety', () => {
  const hostile = '[run](command:workbench.action.terminal.new) <script>alert(1)</script> $(zap) **bold** https://evil.example `code`';

  it('escapes Markdown, HTML and icon syntax in untrusted text', () => {
    const escaped = escapeText(hostile);
    expect(escaped).not.toMatch(/(^|[^\\])[[\]()*`$<>]/);
    expect(escaped).toContain('&lt;script&gt;');
    expect(escaped).not.toContain('https://');
  });

  it('renders a hostile prompt, author, summary and model as text', () => {
    const { markdown, enabledCommands } = renderCard(
      attribution({
        edit: edit({ model: hostile }),
        turn: turn({ prompt: hostile, agent: { name: hostile } }),
        commit: { ...commit, author: hostile, summary: hostile },
      }),
      { now: NOW, file: 'src/a.ts' },
    );
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('](command:workbench');
    expect(markdown).not.toContain('$(zap)');
    // Every command a link can run is one of ours, and all of ours are allowlisted.
    const commands = linkedCommands(markdown).filter((id) => id !== 'workbench.action.terminal.new');
    expect(commands.length).toBeGreaterThan(0);
    for (const id of commands) expect(HOVER_COMMANDS).toContain(id);
    expect(enabledCommands).toEqual([...HOVER_COMMANDS]);
    expect(enabledCommands.every((id) => id.startsWith('threadTrace.'))).toBe(true);
  });

  it('renders hostile commit trailers as text and never as a link target', () => {
    const { markdown } = renderCard(
      attribution({ confidence: 'commit', edit: undefined, turn: undefined, commit: { ...commit, trailers: { coAuthor: hostile, session: 'https://claude.ai/x") [y](command:workbench.action.terminal.new) ("' } } }),
      { now: NOW },
    );
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('](command:workbench');
    expect(markdown).not.toContain('$(zap)');
    expect(markdown).not.toContain('claude.ai/x');
    for (const id of linkedCommands(markdown).filter((id) => id !== 'workbench.action.terminal.new')) expect(HOVER_COMMANDS).toContain(id);
  });

  it('keeps hostile ids inside the link they belong to', () => {
    const id = 's1:p1") [x](command:workbench.action.terminal.new) ("';
    const { markdown } = renderCard(attribution({ turn: turn({ id }) }), { now: NOW });
    expect(markdown).not.toContain('](command:workbench');
    expect(markdown).not.toMatch(/command:threadTrace\.copyPrompt\?[^ ]*[()"]/);
  });
});
