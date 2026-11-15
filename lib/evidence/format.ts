import { EVIDENCE_COPY } from '@/lib/evidence/copy';

/**
 * Pure name and number helpers for evidence. No server or browser import (the copy module imports nothing), so client
 * components use them.
 */

/** The bidi controls a file name must not carry on screen or in a header: U+202A to U+202E, U+2066 to U+2069. */
export const BIDI_CONTROLS = /[\u202A-\u202E\u2066-\u2069]/g;

/** A name without bidi controls. The stored name is never changed; only what is shown or sent in a header. */
export function stripBidiControls(name: string): string {
  return name.replace(BIDI_CONTROLS, '');
}

/**
 * Where a link goes, as a reader sees it beside the name its author gave it (link spoofing: a name can claim any site).
 * The address's host as the URL parser reads it (a look-alike international name in its punycode form, the form the
 * browser resolves; no user, password or port), bidi controls removed (E14). An address with no host, or one that does
 * not parse as a URL, is returned whole with its bidi controls removed, so the reader still sees what was stored; it
 * never throws. Pure: `URL` is a global on the server and in the browser.
 */
export function linkHost(url: string): string {
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // Not a URL: the whole address is what the reader is shown (below). No link is drawn for it (isHttpUrl is false).
  }
  return stripBidiControls(host === '' ? url : host);
}

/** M-13's two numbers: megabytes (1,000,000 bytes) with one decimal. */
export function formatMbPair(loaded: number, total: number): { x: string; y: string } {
  return { x: (loaded / 1e6).toFixed(1), y: (total / 1e6).toFixed(1) };
}

/** The kind of a stored type, in the words of W-3's help line (UX-39). */
export function evidenceKind(mimeType: string): string {
  switch (mimeType) {
    case 'application/pdf': return EVIDENCE_COPY.kinds.pdf;
    case 'image/png': return EVIDENCE_COPY.kinds.png;
    case 'image/jpeg': return EVIDENCE_COPY.kinds.jpeg;
    case 'application/zip': return EVIDENCE_COPY.kinds.zip;
    default: return EVIDENCE_COPY.kinds.office;
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
