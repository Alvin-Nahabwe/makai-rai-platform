/**
 * Sentence and word counting for the content tests (CW-03). `sentences` splits where CNT's `sentenceCount` counts a
 * sentence end (lib/content/validate.ts: a run of `[.!?]` followed by whitespace or the end), so a text this helper
 * sees as N sentences is N sentences to the release check too.
 */

/** The sentences of `text`: split after each run of `[.!?]` followed by whitespace or the end; empty pieces dropped. */
export function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])(?=\s|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** The words of one sentence: runs of non-space characters. */
export function words(sentence: string): number {
  return sentence.split(/\s+/).filter((w) => w.length > 0).length;
}
