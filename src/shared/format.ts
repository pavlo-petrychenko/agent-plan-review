/** Small pure formatting helpers shared by server and client. */

/** "line 12" / "lines 12–15" — human label for a comment anchor. */
export function formatLineLabel(line: number | null, lineEnd: number | null): string {
  if (line == null) return 'general';
  if (lineEnd == null || lineEnd <= line) return `line ${line}`;
  return `lines ${line}–${lineEnd}`;
}

export function truncate(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
