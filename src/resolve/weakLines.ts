// Weak lines (docs/SPEC.md, "Weak lines"): blank or very common lines that
// can't identify who wrote them. A weak line never matches on its own; the
// resolver lets it inherit from a strong neighbor in the same hunk.

// Compared after punctuation is removed and case is folded, so `} else {`,
// `else:` and `return;` are all covered.
const COMMON = new Set([
  'else',
  'end',
  'do',
  'then',
  'fi',
  'done',
  'esac',
  'pass',
  'break',
  'continue',
  'return',
  'return null',
  'return nil',
  'return none',
  'return true',
  'return false',
  'try',
  'finally',
  'begin',
  'endif',
  'default',
]);

export function isWeak(line: string): boolean {
  const text = line.trim();
  if (text === '') return true;
  // Only brackets and punctuation: `}`, `);`, `*/`, `],` and so on.
  if (!/[\p{L}\p{N}]/u.test(text)) return true;
  const words = text
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .toLowerCase();
  return COMMON.has(words);
}
