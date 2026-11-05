import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { Document, Page, renderToBuffer, Text } from '@react-pdf/renderer';
import { createElement } from 'react';
import type { DocumentType } from '@/types/record';
import type { FieldMap, FieldSource } from '@/types/documents';
import { loadContent } from '@/lib/content/loader';
import { loadFieldMap, parseFieldMap } from '@/lib/documents/fieldMaps';
import { formatUtcDay } from '@/lib/documents/resolve';
import { ERASABLE_FIELDS } from '@/lib/documents/copy';
import { pdfTextRuns } from '../helpers/pdfText';

// Every test here runs on the fixture content bundle (the vitest setup file mocks lib/content/root; SRS line 5200).
const fixture = () => loadContent('0.0.1-fixture');

const range = (p: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${p}-${String(from + i).padStart(2, '0')}`);
const mapWith = (source: FieldSource): unknown => ({
  documentType: 'data_card', homeStage: 'pre-processing', templateVersion: '5.0.0',
  fields: [{ fieldId: 'DC-99', label: 'A field', section: 'Section', sources: [source], typedAddition: false }],
});

/** An uncompressed seven-object PDF whose bytes this test controls: the decoding rule is pinned on them, not only on react-pdf's output. */
function handBuiltPdf(a: { cmap: string; content: string; flate?: boolean }): Buffer {
  const stream = (dict: string, body: string, flate = false) => {
    const bytes = flate ? deflateSync(Buffer.from(body, 'latin1')) : Buffer.from(body, 'latin1');
    return Buffer.concat([
      Buffer.from(`<< ${dict}${flate ? ' /Filter /FlateDecode' : ''} /Length ${bytes.length} >>\nstream\n`, 'latin1'), bytes, Buffer.from('\nendstream', 'latin1'),
    ]);
  };
  const objs: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> >>'),
    stream('', a.content, a.flate),
    Buffer.from('<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /ToUnicode 7 0 R >>'),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'),
    stream('', a.cmap),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n')];
  const offsets: number[] = [];
  let length = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = [`xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`, ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`));
  return Buffer.concat(parts);
}

describe('the committed field maps', () => {
  it('FR-DOC-01 (10.3.2-10.3.4): the three committed maps hold the 10.3 field ids in template order', () => {
    const ids = (t: DocumentType) => JSON.parse(readFileSync(`data/fieldmaps/${t}.json`, 'utf8')).fields.map((f: { fieldId: string }) => f.fieldId);
    expect(ids('data_card')).toEqual([...range('DC', 1, 16), 'DC-35', ...range('DC', 17, 34)]);
    expect(ids('model_card')).toEqual([...range('MC', 1, 28), 'MC-33', ...range('MC', 29, 32)]);
    expect(ids('mitigation_plan')).toEqual(['MP-01', 'MP-02', 'MP-03', 'MP-04', 'MP-06', 'MP-05', 'MP-07', 'MP-08', 'MP-09', 'MP-10']);
    expect(JSON.parse(readFileSync('data/fieldmaps/data_card.json', 'utf8')).homeStage).toBe('pre-processing');
    expect(JSON.parse(readFileSync('data/fieldmaps/model_card.json', 'utf8')).homeStage).toBe('in-processing');
    expect(JSON.parse(readFileSync('data/fieldmaps/mitigation_plan.json', 'utf8')).homeStage).toBe('review');
  });

  it('FR-DOC-01: loadFieldMap parses each committed map against the running content', () => {
    for (const t of ['data_card', 'model_card', 'mitigation_plan'] as const) {
      const map: FieldMap = loadFieldMap(t);
      expect(map.documentType).toBe(t);
      expect(map.fields.length).toBeGreaterThan(5);
    }
  });

  it('FR-DOC-01 (SRS line 3896): a map naming a question the running content lacks is refused, naming it', () => {
    expect(() => parseFieldMap(mapWith({ kind: 'record', questionId: 'Q-PP-99', parts: ['reason'] }), fixture())).toThrow(/Q-PP-99/);
  });

  it('FR-DOC-01: an option text the question lacks and a scope part on a non-gate are refused', () => {
    expect(() => parseFieldMap(mapWith({ kind: 'record_option', questionId: 'Q-PP-16', option: 'No such option' }), fixture())).toThrow(/No such option/);
    expect(() => parseFieldMap(mapWith({ kind: 'record', questionId: 'Q-PP-12', parts: ['scope'] }), fixture())).toThrow(/scope/);
  });

  it('FR-DOC-01: an options part on a question that is not a checklist is refused', () => {
    expect(() => parseFieldMap(mapWith({ kind: 'record', questionId: 'Q-PP-12', parts: ['options'] }), fixture())).toThrow(/options/);
  });
});

describe('field map checks beyond the record sources', () => {
  it('FR-DOC-01 (M4): a project field that is no project column, an unknown source kind and an unknown typed structure are refused, naming them', () => {
    expect(() => parseFieldMap(mapWith({ kind: 'project', field: 'fundingSourc' }), fixture())).toThrow(/fundingSourc/);
    expect(() => parseFieldMap(mapWith({ kind: 'project', field: 'name' }), fixture())).not.toThrow();
    expect(() => parseFieldMap(mapWith({ kind: 'poster' } as never), fixture())).toThrow(/poster/);
    expect(() => parseFieldMap(mapWith({ kind: 'typed', structured: 'nope' } as never), fixture())).toThrow(/nope/);
  });
});

describe('the erasure key-to-column list', () => {
  it('FR-REV-08 (C4 CR-1): ERASABLE_FIELDS is the VALUES list of erase_text_field in the migration, pair for pair', () => {
    const sql = readFileSync('prisma/migrations/20261030000500_v060_05_functions/migration.sql', 'utf8');
    const values = sql.slice(sql.indexOf('FROM (VALUES'), sql.indexOf(') AS c(tbl, key, text_col, salt_col)'));
    const fromSql = [...values.matchAll(/\('([a-z_]+)',\s*'(\w+)',\s*'(\w+)',\s*'\w+'\)/g)].map((m) => [m[1], m[2], m[3]]);
    expect(fromSql.length).toBeGreaterThan(10);
    expect(ERASABLE_FIELDS.map((r) => [...r])).toEqual(fromSql);
  });
});

describe('pdfTextRuns', () => {
  it('NFR-A11Y-06 (helper): returns the visible text of a react-pdf document in order', async () => {
    const pdf = await renderToBuffer(createElement(Document, { title: 'Data card', language: 'en' }, createElement(Page, null, createElement(Text, null, 'First'), createElement(Text, null, 'Résumé – v2'))));
    expect(pdfTextRuns(pdf)).toEqual(['First', 'Résumé – v2']);
  });

  it('NFR-A11Y-06 (helper, contract pdfText.ts row): decodes through the /ToUnicode of the font the last Tf selected (bfchar; bfrange with a start code and with an array) and through windows-1252 only for a font with none', () => {
    const cmap = [
      '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
      '1 begincodespacerange <0000> <FFFF> endcodespacerange',
      '2 beginbfchar <0001> <004E> <0002> <014B> endbfchar',                              // N, ŋ
      '2 beginbfrange <0010> <0012> <0061> <0020> <0021> [<0065> <0064>] endbfrange',    // a b c (start code); e d (array)
      'endcmap end end',
    ].join('\n');
    const content = 'BT /F1 12 Tf [<0001> 10 <0002>] TJ <001000110012> Tj <00200021> Tj /F2 12 Tf (caf\\351 5 \\200) Tj ET';
    for (const flate of [false, true]) {
      expect(pdfTextRuns(handBuiltPdf({ cmap, content, flate }))).toEqual(['Nŋ', 'abc', 'ed', 'café 5 €']);   // F2 has no /ToUnicode: bytes 0xE9 and 0x80 read as windows-1252
    }
  });
});

describe('formatUtcDay', () => {
  it('FR-DOC-02 (7.5.8): prints the fixed month list, so September is Sep and the day has no leading zero', () => {
    expect(formatUtcDay('2026-11-02T09:00:00.000Z')).toBe('2 Nov 2026');
    expect(formatUtcDay('2026-09-02T23:59:59.000Z')).toBe('2 Sep 2026');
    expect(formatUtcDay('2026-06-30T00:00:00.000Z')).toBe('30 Jun 2026');
  });
});
