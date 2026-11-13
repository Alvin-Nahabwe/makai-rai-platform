/**
 * Marks text that must reach the reader exactly as written: the text of a legal document or the GIZ credit. The
 * vocabulary lint (Task 8) skips what passes through here. It returns the text unchanged.
 */
export function verbatim(kind: 'legal-text' | 'giz-credit', text: string): string {
  void kind;
  return text;
}
