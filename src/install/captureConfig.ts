// Carries the capture settings from VS Code to the hook, which can't read VS
// Code's settings: it reads `~/.thread-trace/config.json` (docs/SPEC.md, "M1
// decisions" and "M5 decisions"). Plain Node, no vscode.
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PromptMode } from '../capture/redact';

/** The settings as the user set them. Undefined means "not set", which is different from the default. */
export interface CaptureSettings {
  prompt?: unknown;
  redact?: unknown;
}

export interface CaptureConfigUpdate {
  /** The file's new text, or undefined when it is already right (or absent and not needed). */
  text?: string;
  /** Patterns in the setting that aren't valid regular expressions. The hook skips them. */
  invalid: string[];
}

const MODES: readonly PromptMode[] = ['full', 'firstLine', 'none'];
const MAX_PATTERNS = 100;
const MAX_PATTERN_LENGTH = 1000;

function patterns(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === 'string' && item !== '' && item.length <= MAX_PATTERN_LENGTH).slice(0, MAX_PATTERNS);
}

function isValid(source: string): boolean {
  try {
    new RegExp(source, 'g');
    return true;
  } catch {
    return false;
  }
}

/**
 * Applies the settings to the config file's text. A setting the user set
 * replaces the file's value. One that isn't set leaves the file's value alone,
 * so a hand-edited file survives, unless `removeUnset` says the user just
 * reset the setting, in which case the key is removed and the hook's default
 * applies. Keys this extension doesn't know are kept.
 */
export function mergeCaptureConfig(existing: string | undefined, settings: CaptureSettings, removeUnset: boolean): CaptureConfigUpdate {
  let current: Record<string, unknown> = {};
  let readable = existing === undefined;
  if (existing !== undefined) {
    try {
      const parsed: unknown = JSON.parse(existing);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        current = parsed as Record<string, unknown>;
        readable = true;
      }
    } catch {
      // The hook can't read it either; it is rewritten if there is something to write.
    }
  }
  const next = { ...current };
  const prompt = MODES.find((mode) => mode === settings.prompt);
  const redact = patterns(settings.redact);
  if (prompt) next.prompt = prompt;
  else if (removeUnset) delete next.prompt;
  if (redact) next.redact = redact;
  else if (removeUnset) delete next.redact;

  const invalid = (redact ?? []).filter((source) => !isValid(source));
  const unchanged = readable && JSON.stringify(next) === JSON.stringify(current);
  // Nothing to say: don't create a file, and leave one that can't be read as it is.
  if (unchanged || (!(existing !== undefined && readable) && Object.keys(next).length === 0)) return { invalid };
  return { text: `${JSON.stringify(next, null, 2)}\n`, invalid };
}

/** Syncs `<home>/config.json` with the settings. Returns the invalid patterns and whether the file was written. */
export function syncCaptureConfig(home: string, settings: CaptureSettings, removeUnset: boolean): CaptureConfigUpdate & { written: boolean } {
  const file = path.join(home, 'config.json');
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const update = mergeCaptureConfig(existing, settings, removeUnset);
  if (update.text === undefined) return { ...update, written: false };
  fs.mkdirSync(home, { recursive: true });
  // The hook may read the file at any moment: write beside it and rename.
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, update.text);
  fs.renameSync(temp, file);
  return { ...update, written: true };
}
