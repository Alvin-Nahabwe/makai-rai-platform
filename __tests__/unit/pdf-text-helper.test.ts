import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { pdfTextRuns } from '../helpers/pdfText';

/** A one-page PDF whose content stream is `content`, framed as pdfkit frames it ("stream\n", the bytes, "\nendstream"), with /Length `lengthEntry` names. */
function pdfWith(data: Buffer, lengthEntry: (n: number) => string, extra = ''): Buffer {
  const head = (s: string) => Buffer.from(s, 'latin1');
  return Buffer.concat([
    head('%PDF-1.3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n'),
    head('3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>\nendobj\n'),
    head(`4 0 obj\n<< /Filter /FlateDecode /Length ${lengthEntry(data.length)} >>\nstream\n`), data, head('\nendstream\nendobj\n'),
    head(extra), head('trailer\n<< /Root 1 0 R >>\n%%EOF\n'),
  ]);
}

/** Deflate data of a small text-show content stream whose last byte is `last`, found by varying a comment inside the stream. */
function deflateEndingIn(last: number): Buffer {
  for (let i = 0; i < 100_000; i += 1) {
    const data = deflateSync(Buffer.from(`BT (Hello) Tj ET\n% ${String.fromCharCode(33 + (i % 90))}${String.fromCharCode(33 + (Math.floor(i / 90) % 90))}${'~'.repeat(Math.floor(i / 8100) % 8)}\n`, 'latin1'));
    if (data[data.length - 1] === last) return data;
  }
  throw new Error(`no deflate stream ending in 0x${last.toString(16)} found`);
}

describe('pdfText helper (stream ends)', () => {
  it('NFR-A11Y-06 (helper): a FlateDecode stream whose deflate data ends in 0x0d or 0x0a keeps its last byte', () => {
    for (const last of [0x0d, 0x0a]) {
      const data = deflateEndingIn(last);
      expect(pdfTextRuns(pdfWith(data, (n) => String(n))), `ends in 0x${last.toString(16)}`).toEqual(['Hello']);
    }
  });

  it('NFR-A11Y-06 (helper): with an indirect /Length the stream ends at "endstream", and exactly one line feed before it is framing', () => {
    const data = deflateEndingIn(0x41);
    expect(pdfTextRuns(pdfWith(data, () => '5 0 R', '5 0 obj\n999\nendobj\n'))).toEqual(['Hello']);
  });

  it('NFR-A11Y-06 (helper): an uncompressed stream is read whole, and a stream that contains the word endstream inside its /Length is not cut', () => {
    const body = Buffer.from('BT (Hello) Tj ET\n% endstream inside a comment\nBT (World) Tj ET\n', 'latin1');
    const pdf = Buffer.concat([
      Buffer.from('%PDF-1.3\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << >> >>\nendobj\n', 'latin1'),
      Buffer.from(`4 0 obj\n<< /Length ${body.length} >>\nstream\n`, 'latin1'), body, Buffer.from('\nendstream\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n', 'latin1'),
    ]);
    // 'World' follows the inner endstream: a reader that stops there instead of at /Length would lose it.
    expect(pdfTextRuns(pdf)).toEqual(['Hello', 'World']);
  });
});
