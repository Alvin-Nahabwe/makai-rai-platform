import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { claimMatches } from '@/lib/claims/pattern';
import type { FieldMap } from '@/types/documents';
import type { DocumentType } from '@/types/record';

// The shape of `UncstTable` (lib/help/uncst.ts, PUB's type; contract Services row). Declared here so that
// this file needs no lib/help module (PUB-2, not yet merged).
type UncstIssueId = 'a' | 'b' | 'c' | 'd' | 'e' | 'f';
interface UncstTable {
  source: string;
  issues: Array<{ id: UncstIssueId; title: string; dataCardFields: string[]; mitigationPlanFields: string[]; note: string | null }>;
}

// Contract row `data/uncst-16-6.json`, first letter capital (SRS line 5635).
const TITLES = ['Consent to use data', 'Safety and transparency', 'Algorithmic fairness and bias', 'Data integrity', 'Privacy', 'Ownership'];

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const readUncst = (): UncstTable => JSON.parse(read('data/uncst-16-6.json')) as UncstTable;
const readMap = (t: DocumentType): FieldMap => JSON.parse(read(`data/fieldmaps/${t}.json`)) as FieldMap;

describe('OD-20 UNCST 16.6 table', () => {
  it('OD-20 FR-DOC-01: six issues a to f in order with the exact titles', () => {
    const t = readUncst();
    expect(Object.keys(t).sort()).toEqual(['issues', 'source']);
    expect(t.issues.map((i) => i.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(t.issues.map((i) => i.title)).toEqual(TITLES);
    for (const i of t.issues) expect(Object.keys(i).sort()).toEqual(['dataCardFields', 'id', 'mitigationPlanFields', 'note', 'title']);
    for (const i of t.issues) expect(i.note === null || (typeof i.note === 'string' && i.note.length > 0), `${i.id} note is null or text`).toBe(true);
    expect(t.source).toMatch(/UNCST/);
    expect(t.source).toMatch(/16\.6/);
  });

  it('OD-20: every listed field id exists in its map, once per issue', () => {
    const dc = new Set(readMap('data_card').fields.map((f) => f.fieldId));
    const mp = new Set(readMap('mitigation_plan').fields.map((f) => f.fieldId));
    for (const i of readUncst().issues) {
      for (const [ids, set] of [[i.dataCardFields, dc], [i.mitigationPlanFields, mp]] as const) {
        expect(new Set(ids).size, i.id).toBe(ids.length);
        for (const id of ids) expect(set.has(id), `${i.id} ${id}`).toBe(true); // DC-nn only in the data card map, MP-nn only in the mitigation plan map
      }
    }
  });

  it('OD-20: every issue has at least one field or a note', () => {
    for (const i of readUncst().issues) {
      expect(i.dataCardFields.length + i.mitigationPlanFields.length > 0 || (i.note ?? '').length > 0, i.id).toBe(true);
    }
  });

  it('OD-20: (c) says fairness results cannot exist before training, and (f) lists DC-30', () => {
    const by = Object.fromEntries(readUncst().issues.map((i) => [i.id, i]));
    expect(by.c.note).toMatch(/after training/i);
    expect(by.c.note).toMatch(/before training/i);
    expect(by.f.dataCardFields).toContain('DC-30'); // SRS line 5635: "(f) ownership is DC-30"
  });

  it('OD-20 FR-PUB-01: no title or note makes a claim or holds a dash', () => {
    const t = readUncst();
    for (const s of [...t.issues.flatMap((i) => [i.title, i.note ?? '']), t.source]) {
      expect(claimMatches(s), s).toEqual([]);
      expect(/[\u2014\u2013]/.test(s), s).toBe(false);
    }
  });
});
