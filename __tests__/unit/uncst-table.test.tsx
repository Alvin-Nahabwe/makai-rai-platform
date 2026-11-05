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

function labelsOf(map: 'data_card' | 'mitigation_plan'): Record<string, string> {
  const raw = JSON.parse(
    fsMock.readFileSync(`data/fieldmaps/${map}.json`, 'utf8') as string,
  ) as { fields: Array<{ fieldId: string; label: string }> };
  return Object.fromEntries(raw.fields.map((f) => [f.fieldId, f.label]));
}

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
      if (i.dataCardFields.length === 0 || i.mitigationPlanFields.length === 0 || !i.note) {
        expect(text).toContain('None');
      }
    });
  });

  it('OD-20: fieldLabels throws naming an id the map lacks', () => {
    expect(() => fieldLabels(['DC-99'], { 'DC-01': 'x' })).toThrow(/DC-99/);
    expect(fieldLabels(['DC-01'], { 'DC-01': 'x' })).toEqual(['x']);
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

  it('OD-20 NFR-SEC-11: file text renders as text', () => {
    const real = JSON.parse(readFileSync('data/uncst-16-6.json', 'utf8')) as {
      issues: Array<{ title: string }>;
    };
    real.issues[0].title = '<b>x</b>';
    fsMock.readFileSync.mockImplementationOnce(() => JSON.stringify(real));
    const markup = renderToStaticMarkup(<UncstTable />);
    expect(markup).toContain('&lt;b&gt;');
    expect(markup).not.toContain('<b>x</b>');
  });

  it('OD-20 UX-03: the About page shows the table inside the Help and contact section', () => {
    const page = renderToStaticMarkup(<AboutPage />);
    const at = page.search(/<h2[^>]*id="help-and-contact"/);
    expect(at).toBeGreaterThan(-1);
    expect(page.slice(at)).toContain('<caption');
  });
});
