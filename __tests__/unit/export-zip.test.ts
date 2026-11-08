import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { openZipFile, safeEvidenceEntryName, zipLimits } from '../../lib/export/zip';

/**
 * The team export's ZIP writer (SRS 6.3, ADR-C7): entry names an uploader cannot steer out of
 * `evidence/` (NFR-SEC-11, SRS line 1412), entries stored uncompressed, UTF-8 names flagged, and a
 * file only its owner can read.
 */

type Header = { name: string; flags: number; method: number };

/**
 * Every local file header, found through the central directory: fflate sets bit 3 (data
 * descriptor), so a local header carries no sizes and cannot be walked on its own.
 */
function localHeaders(buf: Buffer): Header[] {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  if (eocd < 0) throw new Error('no end of central directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let at = buf.readUInt32LE(eocd + 16);
  const out: Header[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error(`no central header at ${at}`);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`no local header at ${local}`);
    const localNameLength = buf.readUInt16LE(local + 26);
    out.push({
      flags: buf.readUInt16LE(local + 6),
      method: buf.readUInt16LE(local + 8),
      name: buf.subarray(local + 30, local + 30 + localNameLength).toString('utf8'),
    });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

const PDF_BYTES = new Uint8Array(Buffer.from('%PDF-1.4 fixture bytes'));
const JSON_BYTES = new Uint8Array(Buffer.from('{"format":"makrai.team-export/1"}'));

describe('safeEvidenceEntryName', () => {
  it.each([
    ['../../x.txt', 'evidence/e1-x.txt'],
    ['Résumé – consent "v2".pdf', 'evidence/e1-Résuméconsentv2.pdf'],
    ['<img src=x onerror=alert(1)>.png', 'evidence/e1-imgsrcxonerroralert1.png'],
    ['invoice\u202efdp.exe.pdf', 'evidence/e1-invoicefdp.exe.pdf'],
    ['..\\..\\boot.ini', 'evidence/e1-boot.ini'],
    ['...', 'evidence/e1-file'],
    [null, 'evidence/e1-file'],
  ])('FR-EXP-01 NFR-SEC-11: evidence entry names stay inside evidence/ (%s)', (name, entry) => {
    expect(safeEvidenceEntryName('e1', name)).toBe(entry);
  });

  it('FR-EXP-01 NFR-SEC-11: a decomposed name is stored in its composed form', () => {
    expect(safeEvidenceEntryName('e1', 'Résumé.pdf')).toBe('evidence/e1-Résumé.pdf');
  });

  it('FR-EXP-01: a 255-byte name keeps at most 100 characters', () => {
    expect([...safeEvidenceEntryName('e1', 'a'.repeat(251) + '.pdf').slice('evidence/e1-'.length)]).toHaveLength(100);
  });
});

describe('openZipFile', () => {
  let dir: string;
  let tmp: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'export-zip-test-'));
    tmp = join(dir, 'out.zip');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('FR-EXP-01 (ADR-C7): entries are stored uncompressed, non-ASCII names carry the UTF-8 flag, and the archive reads back', () => {
    const z = openZipFile(tmp);
    z.add('evidence/e1-Résumé.pdf', PDF_BYTES);
    z.add('export.json', JSON_BYTES);
    const size = z.finish();
    const buf = readFileSync(tmp);
    expect(size).toBe(buf.length);
    const headers = localHeaders(buf);
    expect(headers.map((h) => h.name)).toEqual(['evidence/e1-Résumé.pdf', 'export.json']);
    for (const h of headers) {
      expect(h.method).toBe(0);
      if (/[^\x00-\x7f]/.test(h.name)) expect(h.flags & 0x800).toBe(0x800);
    }
    const files = unzipSync(new Uint8Array(buf));
    expect(Object.keys(files)).toEqual(['evidence/e1-Résumé.pdf', 'export.json']);
    expect(Buffer.from(files['evidence/e1-Résumé.pdf'])).toEqual(Buffer.from(PDF_BYTES));
    expect(statSync(tmp).mode & 0o777).toBe(0o600);
  });

  it('FR-EXP-01 ADR-C7: an existing file is never opened or overwritten', () => {
    openZipFile(tmp).finish();
    expect(() => openZipFile(tmp)).toThrow(/EEXIST/);
  });

  it('FR-EXP-01 ADR-C7: abort closes the file of an archive that will not be finished', () => {
    const open = () => readdirSync('/proc/self/fd').length;
    const before = open();
    const z = openZipFile(tmp);
    z.add('export.json', JSON_BYTES);
    expect(open()).toBe(before + 1);
    z.abort();
    expect(open()).toBe(before);
    z.abort(); // a second abort does nothing
    expect(() => z.add('README.txt', JSON_BYTES)).toThrow(/already finished or failed/);
  });

  it('FR-EXP-01 ADR-C7: an archive past the ZIP limits fflate can write is refused, never written corrupt', () => {
    const many = openZipFile(tmp, { maxEntries: 2, maxBytes: 1 << 20 });
    many.add('a', JSON_BYTES); many.add('b', JSON_BYTES);
    expect(() => many.add('c', JSON_BYTES)).toThrow(/more than 2 entries/);
    rmSync(tmp);
    const big = openZipFile(tmp, { maxEntries: 10, maxBytes: 200 });
    big.add('a', JSON_BYTES);
    expect(() => big.add('b', new Uint8Array(200))).toThrow(/more than 200 bytes/);
  });

  it('FR-EXP-01 ADR-C7: the default limits are the classic ZIP format\'s', () => {
    expect(zipLimits).toEqual({ maxEntries: 0xffff, maxBytes: 0xffffffff });
  });
});
