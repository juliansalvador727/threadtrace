// Pure merge logic for Claude Code hook settings. No vscode and no file I/O,
// so it can be unit-tested directly. hookInstaller.ts does the confirmation and writing.

type Json = Record<string, unknown>;

/** Any hook command that runs this script is ours. */
const SCRIPT_NAME = 'tt-capture.js';
const EDIT_MATCHER = 'Edit|Write|MultiEdit';

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The command line for one hook. The script path is quoted so paths with spaces work. */
export function hookCommand(scriptPath: string, mode: 'prompt' | 'edit'): string {
  return `node "${scriptPath}" ${mode}`;
}

function isOurs(handler: unknown): boolean {
  return isObject(handler) && typeof handler.command === 'string' && handler.command.includes(SCRIPT_NAME);
}

/** Drops our handlers from one event's groups, and any group left with no handlers. */
function withoutOurs(groups: unknown): unknown[] {
  if (!Array.isArray(groups)) return [];
  const kept: unknown[] = [];
  for (const group of groups) {
    if (!isObject(group) || !Array.isArray(group.hooks)) {
      kept.push(group);
      continue;
    }
    const handlers = group.hooks.filter((handler) => !isOurs(handler));
    if (handlers.length > 0) kept.push({ ...group, hooks: handlers });
  }
  return kept;
}

/** Returns a copy of `settings` with Thread Trace's hooks removed. Other hooks are untouched. */
export function removeHooks(settings: Json): Json {
  if (!isObject(settings.hooks)) return { ...settings };
  const hooks: Json = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const kept = withoutOurs(groups);
    if (kept.length > 0) hooks[event] = kept;
  }
  const result: Json = { ...settings };
  if (Object.keys(hooks).length > 0) result.hooks = hooks;
  else delete result.hooks;
  return result;
}

/**
 * Returns a copy of `settings` with Thread Trace's two hooks present exactly
 * once. Installing twice gives the same result as installing once.
 */
export function mergeHooks(settings: Json, scriptPath: string): Json {
  const result = removeHooks(settings);
  const hooks: Json = isObject(result.hooks) ? { ...result.hooks } : {};
  const existing = (event: string): unknown[] => (Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []);
  hooks.UserPromptSubmit = [
    ...existing('UserPromptSubmit'),
    { hooks: [{ type: 'command', command: hookCommand(scriptPath, 'prompt') }] },
  ];
  hooks.PostToolUse = [
    ...existing('PostToolUse'),
    { matcher: EDIT_MATCHER, hooks: [{ type: 'command', command: hookCommand(scriptPath, 'edit') }] },
  ];
  result.hooks = hooks;
  return result;
}

/** True when `settings` already contains at least one Thread Trace hook. */
export function hasHooks(settings: Json): boolean {
  if (!isObject(settings.hooks)) return false;
  return Object.values(settings.hooks).some(
    (groups) =>
      Array.isArray(groups) &&
      groups.some((group) => isObject(group) && Array.isArray(group.hooks) && group.hooks.some(isOurs)),
  );
}

/** Parses a settings file's text. Empty or missing text is an empty settings object. */
export function parseSettings(text: string | undefined): Json {
  if (text === undefined || text.trim() === '') return {};
  const parsed: unknown = JSON.parse(text);
  if (!isObject(parsed)) throw new Error('settings file is not a JSON object');
  return parsed;
}

export function formatSettings(settings: Json): string {
  return JSON.stringify(settings, null, 2) + '\n';
}
