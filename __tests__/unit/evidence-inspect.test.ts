import { describe, it, expect } from 'vitest';
import { inspect, MAX_BYTES } from '@/lib/evidence/inspect';

const pdf  = Buffer.from('255044462d312e34', 'hex');            // %PDF-1.4
const png  = Buffer.from('89504e470d0a1a0a', 'hex');
const jpeg = Buffer.from('ffd8ffe000104a46', 'hex');
const zip  = Buffer.from('504b03040a000000', 'hex');            // PK.. -- docx/xlsx/pptx
const html = Buffer.from('<html><script>alert(1)</script>');

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

  it('rejects HTML even when it would be declared as an image (O-7)', () => {
    const r = inspect(html);
    expect(r.ok).toBe(false);
  });

  it('rejects an empty buffer', () => {
    expect(inspect(Buffer.alloc(0)).ok).toBe(false);
  });

  it('rejects a buffer over the size limit', () => {
    expect(inspect(Buffer.alloc(MAX_BYTES + 1)).ok).toBe(false);
  });
});
