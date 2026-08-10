import { describe, it, expect } from 'vitest';
import { inspect, MAX_BYTES } from '@/lib/evidence/inspect';

const pdf  = Buffer.from('255044462d312e34', 'hex');            // %PDF-1.4
const png  = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46', 'hex');
const zip  = Buffer.from('504b03040a000000', 'hex');            // PK.. -- docx/xlsx/pptx
const html = Buffer.from('<html><script>alert(1)</script>');

/**
 * Signature-prefixed on purpose, for the two size-boundary tests below. A
 * zero-filled buffer of the same lengths (e.g. `Buffer.alloc(MAX_BYTES + 1)`)
 * would be rejected by the "no signature matched" fallthrough whether or not
 * the size guard exists -- no signature starts with 0x00 -- so it proves
 * nothing about the guard a size test is meant to pin. These fixtures carry
 * a genuine PDF prefix, so the size guard is the ONLY thing that can decide
 * them either way. See task-5-report.md, fix round 1, for how the original
 * zero-filled fixture was found to be vacuous.
 */
const pdfAtLimit   = Buffer.concat([pdf, Buffer.alloc(MAX_BYTES - pdf.length)]);      // length === MAX_BYTES
const pdfOverLimit = Buffer.concat([pdf, Buffer.alloc(MAX_BYTES - pdf.length + 1)]);  // length === MAX_BYTES + 1

describe('inspect', () => {
  it('accepts a PDF by magic bytes', () => {
    expect(inspect(pdf)).toEqual({ ok: true, mimeType: 'application/pdf' });
  });

  it('accepts PNG and JPEG', () => {
    expect(inspect(png)).toEqual({ ok: true, mimeType: 'image/png' });
    expect(inspect(jpeg)).toEqual({ ok: true, mimeType: 'image/jpeg' });
  });

  it('accepts a ZIP container and labels it as such, NOT as a Word document (D-139)', () => {
    // .docx/.xlsx/.pptx are ZIP archives; magic bytes establish "zip", not
    // "document". Recording that limit as an assertion is the point.
    expect(inspect(zip)).toEqual({ ok: true, mimeType: 'application/zip' });
  });

  it('rejects HTML even when it would be declared as an image (O-7): the no-signature-matched case', () => {
    // Proves the default-deny fallthrough: bytes matching no known
    // signature are rejected. html here is far under MAX_BYTES, so this
    // exercises the signature loop only -- it is a different claim from,
    // and does not subsume, the size-guard tests below (and vice versa).
    const r = inspect(html);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty buffer', () => {
    expect(inspect(Buffer.alloc(0)).ok).toBe(false);
  });

  it('accepts a file of exactly MAX_BYTES with a valid signature: the size-boundary accept case', () => {
    // Pins ">" rather than ">=" in the size comparison. Without this, an
    // off-by-one that rejected a file of exactly the permitted size would
    // pass every other test in this file.
    expect(inspect(pdfAtLimit)).toEqual({ ok: true, mimeType: 'application/pdf' });
  });

  it('rejects a file one byte over MAX_BYTES even with a valid signature: the size-guard case', () => {
    // Signature-prefixed so the size guard is the only thing that can
    // reject this -- see the fixture comment above. Asserts the specific
    // reason, not just ok:false, so a bug that rejected this buffer via
    // the signature loop instead of the size guard would also be caught.
    expect(inspect(pdfOverLimit)).toEqual({ ok: false, reason: 'too large' });
  });
});
