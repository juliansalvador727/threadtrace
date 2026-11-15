// Redacts secrets from prompts before they are written (docs/SPEC.md, "Privacy").

export type PromptMode = 'full' | 'firstLine' | 'none';

const REDACTED = '[REDACTED]';

const BUILT_IN: RegExp[] = [
  // Private key blocks.
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // Well-known token formats: Anthropic/OpenAI-style, GitHub, AWS access key id, Slack, Google.
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // JSON Web Tokens.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // Authorization headers.
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/g,
];

// password=..., api_key: "...", SECRET = '...' and similar. Keeps the key, redacts the value.
const KEY_VALUE =
  /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)(\s*[:=]\s*)(["']?)[^\s"',;]+\3/gi;

/** Compiles user-supplied patterns, skipping any that aren't valid regexes. */
export function compilePatterns(sources: unknown): RegExp[] {
  if (!Array.isArray(sources)) return [];
  const patterns: RegExp[] = [];
  for (const source of sources) {
    if (typeof source !== 'string' || source === '') continue;
    try {
      patterns.push(new RegExp(source, 'g'));
    } catch {
      // An invalid user pattern must not stop capture.
    }
  }
  return patterns;
}

export function redact(text: string, extra: RegExp[] = []): string {
  let out = text;
  for (const pattern of BUILT_IN) out = out.replace(pattern, REDACTED);
  out = out.replace(KEY_VALUE, (_match, key: string, separator: string) => `${key}${separator}${REDACTED}`);
  for (const pattern of extra) out = out.replace(pattern, REDACTED);
  return out;
}

/** Applies `threadTrace.capture.prompt`, then redacts. */
export function preparePrompt(prompt: string, mode: PromptMode, extra: RegExp[] = []): string {
  if (mode === 'none') return '';
  const kept = mode === 'firstLine' ? (prompt.trimStart().split(/\r?\n/, 1)[0] ?? '') : prompt;
  return redact(kept, extra);
}
