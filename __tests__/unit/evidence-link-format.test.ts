import { describe, it, expect } from 'vitest';
import { isHttpUrl, parseLinkEvidenceBody } from '@/lib/evidence/link';
import { formatMbPair, stripBidiControls, evidenceKind, normaliseFileName } from '@/lib/evidence/format';

const R = '3f1c7a52-9b7e-4c55-8c1e-0d9f6f0a1b11';
const URL_MSG = 'Enter a web address that starts with http:// or https://.';

describe('evidence link and name helpers', () => {
  it('FR-EVD-01 NFR-SEC-10: javascript:, data: and ftp: links are refused; http and https are kept', () => {
    for (const url of ['ftp://x', 'javascript:alert(1)', 'data:text/html,<b>x</b>', 'JAVASCRIPT:alert(1)', 'example.org'])
      expect(() => parseLinkEvidenceBody({ requestId: R, kind: 'link', url, label: null }))
        .toThrow(expect.objectContaining({ status: 422, extra: { fields: [{ field: 'url', message: URL_MSG }] } }));
    expect(parseLinkEvidenceBody({ requestId: R, kind: 'link', url: 'https://example.org/ethics.pdf', label: '  ' }))
      .toEqual({ requestId: R, kind: 'link', url: 'https://example.org/ethics.pdf', label: null });
    expect(isHttpUrl('HTTP://Example.org')).toBe(true);
  });
  it('FR-EVD-01: a URL over 2,048 characters or a label over 200 is refused', () => {
    expect(() => parseLinkEvidenceBody({ requestId: R, kind: 'link', url: 'https://e.org/' + 'a'.repeat(2035), label: null })).toThrow(expect.objectContaining({ status: 422 }));
    expect(() => parseLinkEvidenceBody({ requestId: R, kind: 'link', url: 'https://e.org/', label: 'x'.repeat(201) })).toThrow(expect.objectContaining({ status: 422 }));
  });
  it('M-13: the upload pair is in MB with one decimal', () => {
    expect(formatMbPair(800_000, 2_400_000)).toEqual({ x: '0.8', y: '2.4' });
  });
  it('NFR-SEC-11 FR-EVD-02: the bidi controls U+202A to U+202E and U+2066 to U+2069 are removed and nothing else', () => {
    expect(stripBidiControls('invoice\u202Efdp.exe.pdf')).toBe('invoicefdp.exe.pdf');
    expect(stripBidiControls('a\u202Ab\u202Bc\u202Cd\u202De\u2066f\u2067g\u2068h\u2069i.pdf')).toBe('abcdefghi.pdf');
    expect(stripBidiControls('Café \u200F ملف.pdf')).toBe('Café \u200F ملف.pdf');
  });
  it('UX-39: the kind of an evidence download is named from its stored type', () => {
    expect(['application/pdf', 'image/png', 'image/jpeg', 'application/zip'].map(evidenceKind)).toEqual(['PDF', 'PNG', 'JPEG', 'ZIP']);
    expect(evidenceKind('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('Office document');
  });
  it('NFR-SEC-11 FR-EVD-02 (E-name): normaliseFileName removes C0 and C1 controls, trims, caps at 255 code points keeping a short extension, and never returns an empty name', () => {
    expect(normaliseFileName('a\r\nb\u0000c\u007fd\u0085e.pdf')).toBe('abcde.pdf');
    expect(normaliseFileName('  memo.pdf \t')).toBe('memo.pdf');
    const long = normaliseFileName('x'.repeat(296) + '.pdf');
    expect(long.endsWith('.pdf')).toBe(true);
    expect(Array.from(long)).toHaveLength(255);
    const emoji = normaliseFileName('\u{1F600}'.repeat(300) + '.pdf');
    expect(Array.from(emoji)).toHaveLength(255);
    expect(emoji.endsWith('.pdf')).toBe(true);
    expect(Array.from(normaliseFileName('\u{1F600}'.repeat(300)))).toHaveLength(255);
    expect(Array.from(normaliseFileName('y'.repeat(300) + '.' + 'z'.repeat(20)))).toHaveLength(255);   // extension over 16 code points: plain cut
    expect(normaliseFileName('   ')).toBe('file');
    expect(normaliseFileName('\u0000\u001f')).toBe('file');
    const bidi = 'invoice\u202Efdp.exe.pdf';
    expect(normaliseFileName(bidi)).toBe(bidi);
  });
});
