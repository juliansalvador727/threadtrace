import { describe, expect, it } from 'vitest';
import {
  formatSettings,
  hasHooks,
  hookCommand,
  mergeHooks,
  parseSettings,
  removeHooks,
} from '../../src/install/hookConfig';

const SCRIPT = '/home/user/.thread-trace/bin/tt-capture.js';

describe('mergeHooks', () => {
  it('adds both hooks to empty settings', () => {
    expect(mergeHooks({}, SCRIPT)).toEqual({
      hooks: {
        UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node "${SCRIPT}" prompt` }] }],
        PostToolUse: [
          { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: `node "${SCRIPT}" edit` }] },
        ],
      },
    });
  });

  it('keeps unrelated settings and other hooks', () => {
    const settings = {
      permissions: { allow: ['Bash(npm test)'] },
      hooks: {
        PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }],
        Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }],
      },
    };
    const merged = mergeHooks(settings, SCRIPT) as typeof settings & { hooks: Record<string, unknown[]> };
    expect(merged.permissions).toEqual(settings.permissions);
    expect(merged.hooks.Stop).toEqual(settings.hooks.Stop);
    expect(merged.hooks.PostToolUse).toHaveLength(2);
    expect(merged.hooks.PostToolUse[0]).toEqual(settings.hooks.PostToolUse[0]);
  });

  it('is idempotent', () => {
    const once = mergeHooks({}, SCRIPT);
    expect(mergeHooks(once, SCRIPT)).toEqual(once);
  });

  it('replaces a hook that points at an older script path', () => {
    const old = mergeHooks({}, '/old/place/tt-capture.js');
    const merged = mergeHooks(old, SCRIPT);
    expect(JSON.stringify(merged)).not.toContain('/old/place');
    expect(merged).toEqual(mergeHooks({}, SCRIPT));
  });

  it('does not mutate its input', () => {
    const settings = { hooks: { Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }] } };
    const before = JSON.stringify(settings);
    mergeHooks(settings, SCRIPT);
    expect(JSON.stringify(settings)).toBe(before);
  });
});

describe('removeHooks', () => {
  it('undoes an install exactly', () => {
    const settings = {
      model: 'opus',
      hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: './lint.sh' }] }] },
    };
    expect(removeHooks(mergeHooks(settings, SCRIPT))).toEqual(settings);
  });

  it('drops the hooks key when nothing else is left', () => {
    expect(removeHooks(mergeHooks({ model: 'opus' }, SCRIPT))).toEqual({ model: 'opus' });
  });

  it('removes only our handler from a shared group', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [
          {
            hooks: [
              { type: 'command', command: './other.sh' },
              { type: 'command', command: hookCommand(SCRIPT, 'prompt') },
            ],
          },
        ],
      },
    };
    expect(removeHooks(settings)).toEqual({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: './other.sh' }] }] },
    });
  });
});

describe('hasHooks / parseSettings / formatSettings', () => {
  it('detects our hooks', () => {
    expect(hasHooks({})).toBe(false);
    expect(hasHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: './notify.sh' }] }] } })).toBe(false);
    expect(hasHooks(mergeHooks({}, SCRIPT))).toBe(true);
  });

  it('treats a missing or empty file as empty settings', () => {
    expect(parseSettings(undefined)).toEqual({});
    expect(parseSettings('  \n')).toEqual({});
  });

  it('rejects invalid JSON and non-objects instead of overwriting them', () => {
    expect(() => parseSettings('{ not json')).toThrow();
    expect(() => parseSettings('[1, 2]')).toThrow();
  });

  it('round-trips through formatSettings', () => {
    const merged = mergeHooks({ model: 'opus' }, SCRIPT);
    expect(parseSettings(formatSettings(merged))).toEqual(merged);
  });
});
