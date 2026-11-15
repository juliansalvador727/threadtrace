// Normalized Levenshtein similarity, for lines a human changed after an agent wrote them.

// Longer lines (minified code, data) aren't worth the quadratic cost.
const MAX_LENGTH = 1000;

function distance(a: string, b: string): number {
  let previous = new Array<number>(b.length + 1);
  let current = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) previous[j] = j;
  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    [previous, current] = [current, previous];
  }
  return previous[b.length];
}

/** 1 for identical lines, 0 for nothing in common. Leading and trailing whitespace is ignored. */
export function similarity(a: string, b: string): number {
  const left = a.trim();
  const right = b.trim();
  if (left === right) return 1;
  const longest = Math.max(left.length, right.length);
  if (longest > MAX_LENGTH) return 0;
  return 1 - distance(left, right) / longest;
}
