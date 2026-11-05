import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';

/** The mock delegates to the real `readFileSync`; a case overrides it for one read. */
const fsMock = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, default: actual, readFileSync: fsMock.readFileSync };
});

import { readUncstTable } from '@/lib/help/uncst';
import { UncstTable, fieldLabels } from '@/components/help/UncstTable';
import AboutPage from '@/app/(public)/about/page';

/**
 * OD-20 (owner answer A2), UX-03's Help and contact part, NFR-A11Y-04, WCAG 1.3.1.
 * Real files, as C-MAP committed them.
 */
const CAPTION =
  "Which fields answer Uganda's six AI protocol issues (UNCST guidelines 2025, section 16.6)";
const html = renderToStaticMarkup(<UncstTable />);
const plain = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
const rowsOf = (markup: string) => [...markup.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(1); // the first row holds the headers

/** Every field of a map except the one named, so a test can swap in its own version of that field. */
function labelFields(map: 'data_card' | 'mitigation_plan', except: string) {
  const raw = JSON.parse(fsMock.readFileSync(`data/fieldmaps/${map}.json`, 'utf8') as string) as {
    fields: Array<{ fieldId: string; label: string }>;
  };
  return raw.fields.filter((f) => f.fieldId !== except);
}

function labelsOf(map: 'data_card' | 'mitigation_plan'): Record<string, string> {
  const raw = JSON.parse(
    fsMock.readFileSync(`data/fieldmaps/${map}.json`, 'utf8') as string,
  ) as { fields: Array<{ fieldId: string; label: string }> };
  return Object.fromEntries(raw.fields.map((f) => [f.fieldId, f.label]));
}

type Raw = { source: string; issues: Array<Record<string, unknown>> };
const realFile = (): Raw => JSON.parse(readFileSync('data/uncst-16-6.json', 'utf8')) as Raw;
/** Makes the next read of any file return `json`. */
const nextRead = (json: unknown) =>
  fsMock.readFileSync.mockImplementationOnce(() => JSON.stringify(json));

describe('UncstTable', () => {
  it('OD-20 UX-03: readUncstTable returns the file, six issues a to f in order', () => {
    const t = readUncstTable();
    expect(t).toEqual(JSON.parse(readFileSync('data/uncst-16-6.json', 'utf8')));
    expect(t.issues.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(t.source.length).toBeGreaterThan(0);
  });

  it('OD-20: a file without the six ids a to f in order is refused at read, naming the problem', () => {
    const real = JSON.parse(readFileSync('data/uncst-16-6.json', 'utf8')) as {
      issues: Array<{ id: string }>;
    };
    const lacking = { ...real, issues: real.issues.filter((i) => i.id !== 'c') };
    fsMock.readFileSync.mockImplementationOnce(() => JSON.stringify(lacking));
    expect(() => readUncstTable()).toThrow(/issue "c" is missing/);
  });

  it.each([
    ['ids out of order', (r: Raw) => { r.issues.reverse(); }, /ids must be exactly a to f/],
    ['an id with a comma (five issues)', (r: Raw) => { r.issues.splice(0, 2, { ...r.issues[0], id: 'a,b' }); }, /ids must be exactly a to f/],
    ['an id that is an array', (r: Raw) => { r.issues[0].id = ['a']; }, /ids must be exactly a to f/],
    ['a seventh issue', (r: Raw) => { r.issues.push({ ...r.issues[0], id: 'g' }); }, /ids must be exactly a to f/],
    ['an empty title', (r: Raw) => { r.issues[1].title = ' '; }, /issue b needs a non-empty title/],
    ['a field list that is not strings', (r: Raw) => { r.issues[1].dataCardFields = [1]; }, /issue b field lists/],
    ['a field list that is not an array', (r: Raw) => { r.issues[1].mitigationPlanFields = 'MP-03'; }, /issue b field lists/],
    ['a note that is a number', (r: Raw) => { r.issues[2].note = 5; }, /issue c note/],
    ['an id repeated in one list', (r: Raw) => { r.issues[1].dataCardFields = ['DC-21', 'DC-21']; }, /issue b lists field DC-21 more than once/],
    ['an empty note', (r: Raw) => { r.issues[2].note = ''; }, /issue c note/],
    ['a blank note', (r: Raw) => { r.issues[2].note = '   '; }, /issue c note/],
  ])('OD-20: a file with %s is refused at read, naming the file and the problem', (_n, mutate, message) => {
    const r = realFile();
    mutate(r);
    nextRead(r);
    expect(() => readUncstTable()).toThrow(message);
    nextRead(r);
    expect(() => readUncstTable()).toThrow(/data\/uncst-16-6\.json/);
  });

  it('OD-20 UX-03: the table carries the caption and one row per issue, in order', () => {
    expect(plain(html.match(/<caption[^>]*>([\s\S]*?)<\/caption>/)![1])).toBe(CAPTION);
    const rows = rowsOf(html);
    expect(rows).toHaveLength(6);
    rows.forEach((r, k) => expect(plain(r[1])).toContain(readUncstTable().issues[k].title));
  });

  it('OD-20: a field id shows its label, not its id', () => {
    const dc = labelsOf('data_card');
    const mp = labelsOf('mitigation_plan');
    const rows = rowsOf(html);
    readUncstTable().issues.forEach((i, k) => {
      const text = plain(rows[k][1]);
      for (const id of i.dataCardFields) {
        expect(text).toContain(plain(dc[id]));
        expect(text).not.toContain(id);
      }
      for (const id of i.mitigationPlanFields) {
        expect(text).toContain(plain(mp[id]));
        expect(text).not.toContain(id);
      }
      if (i.note) expect(text).toContain(i.note);
    });
  });

  it('OD-20: each empty list and each null note reads None, in its own cell', () => {
    const r = realFile();
    r.issues[0].dataCardFields = [];
    r.issues[0].mitigationPlanFields = [];
    r.issues[0].note = null;
    r.issues[1].note = null;
    nextRead(r);
    const rows = rowsOf(renderToStaticMarkup(<UncstTable />));
    const cells = (row: string) => [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => plain(m[1]));
    expect(cells(rows[0][1])).toEqual(['None', 'None', 'None']);
    const b = cells(rows[1][1]);
    expect(b[0]).not.toBe('None');
    expect(b[1]).not.toBe('None');
    expect(b[2]).toBe('None');
    const c = cells(rows[2][1]);
    expect(c[0]).not.toBe('None');
    expect(c[1]).toBe('None');
    expect(c[2]).not.toBe('None');
  });

  it('OD-20: a field map that is not JSON is refused at read, naming the map', () => {
    nextRead(realFile());
    fsMock.readFileSync.mockImplementationOnce(() => '{bad');
    expect(() => renderToStaticMarkup(<UncstTable />)).toThrow(/data\/fieldmaps\/data_card\.json: not valid JSON/);
  });

  it('OD-20 WCAG 1.3.1: every table part carries its explicit role, so display changes cannot drop the semantics', () => {
    const count = (re: RegExp) => (html.match(re) ?? []).length;
    expect(count(/<table [^>]*role="table"/g)).toBe(1);
    expect(count(/role="rowgroup"/g)).toBe(2);
    expect(count(/<tr [^>]*role="row"/g)).toBe(7);
    expect(count(/role="columnheader"/g)).toBe(4);
    expect(count(/role="rowheader"/g)).toBe(6);
    expect(count(/<td [^>]*role="cell"/g)).toBe(18);
  });

  it('OD-20 NFR-A11Y-05: the table sits in a wrap that is an inline-size container, and the stacking follows it', () => {
    expect(html).toMatch(/^<div class="uncst-table-wrap"><table /);
    const css = readFileSync('components/help/UncstTable.css', 'utf8');
    expect(css).toMatch(/\.uncst-table-wrap\s*\{[^}]*container-type:\s*inline-size/);
    expect(css).toMatch(/@container \(max-width: 600px\)/);
    expect(css).not.toMatch(/@media/);
    // every alt-text label has a plain fallback before it, for engines without alt-text content
    for (const label of ['Data card fields: ', 'Mitigation plan fields: ', 'Note: ']) {
      expect(css).toContain(`content: '${label}';\n    content: '${label}' / '';`);
    }
  });

  it('OD-20: fieldLabels throws naming an id the map lacks', () => {
    expect(() => fieldLabels(['DC-99'], { 'DC-01': 'x' })).toThrow(/DC-99/);
    expect(fieldLabels(['DC-01'], { 'DC-01': 'x' })).toEqual(['x']);
  });

  it('OD-20: fieldLabels names the first missing id, not a later one', () => {
    expect(() => fieldLabels(['DC-01', 'DC-98', 'DC-99'], { 'DC-01': 'x' })).toThrow(/"DC-98"/);
  });

  it('OD-20 WCAG 1.3.1 UX-03: the table has a caption, four column headers and a row header per issue', () => {
    expect(html).toMatch(/<table[\s\S]*<caption/);
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(4);
    expect((html.match(/<th scope="row"/g) ?? []).length).toBe(6);
    expect([...html.matchAll(/<th scope="col"[^>]*>([^<]*)</g)].map((m) => m[1])).toEqual([
      'Issue',
      'Data card fields',
      'Mitigation plan fields',
      'Note',
    ]);
  });

  it('OD-20 NFR-SEC-11: titles, notes and field labels render as text', () => {
    const r = realFile();
    r.issues[0].title = '<b>x</b>';
    r.issues[2].note = '<i>n</i>';
    nextRead(r);
    fsMock.readFileSync.mockImplementationOnce(() =>
      JSON.stringify({ fields: [{ fieldId: 'DC-16', label: '<u>l</u>' }, ...labelFields('data_card', 'DC-16')] }),
    );
    // the uncst read is first, then data_card, then mitigation_plan
    const markup = renderToStaticMarkup(<UncstTable />);
    expect(markup).toContain('&lt;b&gt;');
    expect(markup).toContain('&lt;i&gt;');
    expect(markup).toContain('&lt;u&gt;');
    for (const raw of ['<b>x</b>', '<i>n</i>', '<u>l</u>']) expect(markup).not.toContain(raw);
  });

  it.each([
    ['a field with no label', [{ fieldId: 'DC-16' }], /data_card\.json: field DC-16 needs a non-empty label/],
    ['a field with a blank label', [{ fieldId: 'DC-16', label: ' ' }], /field DC-16 needs a non-empty label/],
    ['a field whose label is not a string', [{ fieldId: 'DC-16', label: 3 }], /field DC-16 needs a non-empty label/],
    ['no fields array', undefined, /"fields" must be an array/],
    ['a field with no fieldId', [{ label: 'x' }], /data_card\.json: every field needs a non-empty fieldId/],
    ['a field whose fieldId is not a string', [{ fieldId: 7, label: 'x' }], /every field needs a non-empty fieldId/],
    ['a field with a blank fieldId', [{ fieldId: ' ', label: 'x' }], /every field needs a non-empty fieldId/],
    ['a repeated fieldId', [{ fieldId: 'DC-16', label: 'x' }, { fieldId: 'DC-16', label: 'y' }], /fieldId DC-16 appears more than once/],
  ])('OD-20: a field map with %s is refused at read, naming the map', (_n, fields, message) => {
    nextRead(realFile());
    fsMock.readFileSync.mockImplementationOnce(() => JSON.stringify({ fields }));
    expect(() => renderToStaticMarkup(<UncstTable />)).toThrow(message);
  });

  it('OD-20 UX-03: the About page shows the table inside the Help and contact section', () => {
    const page = renderToStaticMarkup(<AboutPage />);
    const at = page.search(/<h2[^>]*id="help-and-contact"/);
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at)).toContain('<caption');
  });
});
