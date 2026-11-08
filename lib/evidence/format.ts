/**
 * Pure name and number helpers for evidence. No server or browser import, so client components use them.
 */

/** The bidi controls a file name must not carry on screen or in a header: U+202A to U+202E, U+2066 to U+2069. */
export const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

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

const FILE_NAME_MAX = 255;
const EXTENSION_MAX = 16;

/**
 * The name route 3 stores (E-name): C0 and C1 control characters removed (CR and LF with them), trimmed, cut to 255
 * code points (the last extension kept when it is at most 16 code points with its dot), and "file" when nothing is
 * left. Bidi controls stay: the stored name keeps them byte for byte and they are stripped on output (E14).
 */
export function normaliseFileName(name: string): string {
  const cleaned = Array.from(name.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim());
  let kept = cleaned;
  if (cleaned.length > FILE_NAME_MAX) {
    const dot = cleaned.lastIndexOf('.');
    const extension = dot >= 0 ? cleaned.slice(dot) : [];
    kept = extension.length > 0 && extension.length <= EXTENSION_MAX
      ? [...cleaned.slice(0, FILE_NAME_MAX - extension.length), ...extension]
      : cleaned.slice(0, FILE_NAME_MAX);
  }
  return kept.length === 0 ? 'file' : kept.join('');
}
