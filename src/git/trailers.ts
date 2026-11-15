// Agent trailers in commit messages (docs/SPEC.md, "Commit trailers" and
// "M4 decisions"). They give commit-level attribution when no record matches,
// for example for a session that ran in the cloud.
//
// A commit message is untrusted: anyone can write any trailer. So the session
// link is kept only when it points at claude.ai, and a co-author only counts
// when it is the agent's own address.
import type { CommitInfo } from '../store/schema';
import type { Git } from './exec';

export type Trailers = CommitInfo['trailers'];

/** For `git log` / `git show --format`: the commit's trailers, unfolded, on one line, separated by \x02. */
export const TRAILERS_FORMAT = '%(trailers:only,unfold,separator=%x02)';

const AGENT_EMAIL = 'noreply@anthropic.com';
const SESSION_HOST = 'claude.ai';
const MAX_URL = 500;
const MAX_NAME = 80;

function sessionUrl(value: string): string | undefined {
  if (value.length > MAX_URL || /\s/.test(value)) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === SESSION_HOST && !url.username && !url.password ? value : undefined;
  } catch {
    return undefined;
  }
}

/** `Claude Opus 5.5 <noreply@anthropic.com>` → `Claude Opus 5.5`; undefined for anyone else. */
function agentName(value: string): string | undefined {
  const match = /^(.*?)\s*<([^<>]*)>$/.exec(value);
  if (!match || match[2].trim().toLowerCase() !== AGENT_EMAIL) return undefined;
  return match[1].trim().slice(0, MAX_NAME) || 'Claude';
}

/** Reads trailer lines (`Key: value`), separated by newlines or by git's separator. */
export function parseTrailers(text: string): Trailers {
  const trailers: Trailers = {};
  for (const line of text.split(/[\n\x02]/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (key === 'claude-session') trailers.session ??= sessionUrl(value);
    else if (key === 'co-authored-by') trailers.coAuthor ??= agentName(value);
  }
  return trailers;
}

/** True when the commit message says an agent took part in the commit. */
export function hasAgentTrailer(trailers: Trailers): boolean {
  return trailers.session !== undefined || trailers.coAuthor !== undefined;
}

/** The agent trailers of one commit. Empty when there are none or git fails. */
export async function commitTrailers(git: Git, sha: string): Promise<Trailers> {
  const result = await git.run(['show', '-s', `--format=${TRAILERS_FORMAT}`, sha]);
  return result.code === 0 ? parseTrailers(result.stdout) : {};
}
