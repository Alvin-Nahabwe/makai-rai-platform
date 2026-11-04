/**
 * Pure name and number helpers for evidence. No server or browser import, so client components use them.
 */

/** The bidi controls a file name must not carry on screen or in a header: U+202A to U+202E, U+2066 to U+2069. */
export const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

/** A name without bidi controls. The stored name is never changed; only what is shown or sent in a header. */
export function stripBidiControls(name: string): string {
  return name.replace(BIDI_CONTROLS, '');
}

/** M-13's two numbers: megabytes (1,000,000 bytes) with one decimal. */
export function formatMbPair(loaded: number, total: number): { x: string; y: string } {
  return { x: (loaded / 1e6).toFixed(1), y: (total / 1e6).toFixed(1) };
}

/** The kind of a stored type, in the words of W-3's help line (UX-39). */
export function evidenceKind(mimeType: string): string {
  switch (mimeType) {
    case 'application/pdf': return 'PDF';
    case 'image/png': return 'PNG';
    case 'image/jpeg': return 'JPEG';
    case 'application/zip': return 'ZIP';
    default: return 'Office document';
  }
}
