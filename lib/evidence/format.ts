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
 * A stored link address as the reader's page uses it, parsed ONCE so the address the browser follows and the host the
 * reader is shown cannot disagree (link spoofing: "https:evil.example" is relative in a browser on an https page but reads
 * as evil.example to a parse without a base). `href` is the parsed absolute address, `host` its host as the browser
 * resolves it (a look-alike international name in punycode; no user, password or port), bidi controls removed (E14).
 * Null when the address does not parse or is not http or https: the caller shows it as text, never as a link. Pure:
 * `URL` is a global on the server and in the browser.
 */
export function webLink(url: string): { href: string; host: string } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null; // Not a URL: the caller shows the cleaned address as text, so nothing is hidden from the reader.
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return { href: u.href, host: stripBidiControls(u.hostname) };
}

/**
 * Whether a link's host (as `webLink` gives it: the browser's own resolution, lower case, punycode) is the platform's own
 * public host, so a page does not say "opens another site" of a link that stays on the platform. `publicOrigin` is the
 * configured public origin (lib/publicOrigin.ts `publicOrigin()`, from AUTH_URL or NEXTAUTH_URL), passed in so this stays
 * pure and usable in the browser. The port is not compared: the same host on another port is still this platform's
 * name. An origin that does not parse is never "own", so the caller keeps the "opens another site" warning.
 */
export function isOwnHost(host: string, publicOrigin: string): boolean {
  let own: string;
  try {
    own = new URL(publicOrigin).hostname;
  } catch {
    return false; // No usable origin: never claim a link is the platform's own; the warning stays.
  }
  return own !== '' && host === own;
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
