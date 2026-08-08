/**
 * 10 MiB. Institutional policy documents and screenshots; not datasets.
 *
 * This is a size LIMIT, not a DoS control: by the time a caller has a
 * `Buffer` to pass in, the bytes are already in memory, so rejecting here
 * cannot undo that allocation. The upload route (Task 6) is responsible for
 * gating size before buffering; resource exhaustion is tracked separately
 * in the register, not claimed as solved by this constant.
 */
export const MAX_BYTES = 10 * 1024 * 1024;

export type InspectResult =
  | { ok: true; mimeType: string }
  | { ok: false; reason: string };

/**
 * Magic-byte signatures, longest first so a longer match wins.
 *
 * KNOWN LIMIT, recorded as D-139 rather than left implicit: .docx, .xlsx and
 * .pptx are ZIP archives whose first four bytes are PK\x03\x04, identical to
 * any zip, jar or apk. This function therefore establishes "this is a zip",
 * never "this is a Word document", for the formats most likely to be used as
 * institutional evidence. The residual risk is bounded by the download path,
 * which serves application/octet-stream as an attachment with nosniff (O-8),
 * so a mislabelled archive is never rendered or executed.
 */
const SIGNATURES: ReadonlyArray<{ magic: Buffer; mimeType: string }> = [
  { magic: Buffer.from('89504e470d0a1a0a', 'hex'), mimeType: 'image/png' },
  { magic: Buffer.from('255044462d', 'hex'),       mimeType: 'application/pdf' },
  { magic: Buffer.from('504b0304', 'hex'),         mimeType: 'application/zip' },
  { magic: Buffer.from('ffd8ff', 'hex'),           mimeType: 'image/jpeg' },
];

/**
 * Decides what a file actually is, from its bytes, discarding whatever
 * content-type the uploading client claimed. The one place in the evidence
 * upload path where that claim is not trusted (O-7).
 *
 * Deliberately no plain-text branch. "Looks like text" is not a signature —
 * every rejected binary also looks like text under a loose heuristic, and
 * admitting `text/plain` by exclusion re-opens exactly the HTML-declared-
 * as-an-image case O-7 exists to close. If plain-text evidence is needed
 * later it gets an explicit decision, not a fallthrough. Anything this
 * function cannot positively name is rejected — never accepted by default.
 */
export function inspect(buf: Buffer): InspectResult {
  if (buf.length === 0) return { ok: false, reason: 'empty' };
  if (buf.length > MAX_BYTES) return { ok: false, reason: 'too large' };

  for (const { magic, mimeType } of SIGNATURES) {
    if (buf.length >= magic.length && buf.subarray(0, magic.length).equals(magic)) {
      return { ok: true, mimeType };
    }
  }
  return { ok: false, reason: 'unrecognised file type' };
}
