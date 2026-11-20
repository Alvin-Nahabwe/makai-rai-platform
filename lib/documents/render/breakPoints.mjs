// Where react-pdf may break a word of a PDF (FR-DOC-02): defined once here because two places register it, the main thread's
// renderer (lib/documents/render/font.ts) and the render worker (lib/documents/render/pdfWorker.mjs), which runs this file as it is.
//
// react-pdf hyphenates English by default, which would split "certification" across two text runs, so whole words are kept. A word
// wider than a column (an address, a DOI, a long typed value) has no break point otherwise and is cut off at the line end, which
// would lose the rest of it from a PDF that cannot be recalled: such a word gets break points every 16 characters. The plain-text
// copy carries the exact text. No zero-width space is inserted, since it would be copied with the text.

const LONG_WORD = 24;
const CHUNK = 16;

/**
 * @param {string} word
 * @returns {string[]}
 */
export function breakPoints(word) {
  const chars = [...word];
  if (chars.length <= LONG_WORD) return [word];
  const out = [];
  for (let i = 0; i < chars.length; i += CHUNK) out.push(chars.slice(i, i + CHUNK).join(''));
  return out;
}
