import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { controlsForArea, controlsForQuestion, type ControlGroup } from '@/lib/content/suggestions';
import { handBuiltContent } from '../helpers/suggestionsFixture';

const DIR = '__tests__/fixtures/content/0.0.1-fixture';
const c = handBuiltContent(DIR);
const ids = (gs: ControlGroup[]) => gs.flatMap((g) => g.controls.map((x) => x.control.id));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a raw content file, read only to compute the expected mapping
const json = (f: string): any => JSON.parse(readFileSync(`${DIR}/${f}`, 'utf8'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const allQuestions = (qb: any): any[] => Object.values(qb.stages).flatMap((s: any) => s.modules.flatMap((m: any) => m.questions));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const areasOf = (q: any): string[] => [...q.gaps, ...Object.values(q.optionGapMap ?? {}).flat().map((e: any) => (typeof e === 'string' ? e : e.area))];

describe('suggested controls grouping', () => {
  it('FR-SUG-01: Q-PP-01 shows C-01, C-02, C-20 before any answer', () => {
    expect(controlsForQuestion(c, 'Q-PP-01', [])).toEqual({ first: [expect.objectContaining({ area: expect.objectContaining({ id: 'PP-01' }) })], rest: [] });
    expect(ids(controlsForQuestion(c, 'Q-PP-01', []).first)).toEqual(['C-01', 'C-02', 'C-20']);
  });
  it('FR-SUG-01: for every question the set shown equals the mapping computed from the content files', () => {
    const qb = json('questionBank.json'), aa = json('assessmentAreas.json');
    for (const q of allQuestions(qb)) {
      const expected = q.type === 'gate' ? [] : [...new Set(areasOf(q).flatMap((a) => aa.areas.find((x: { id: string }) => x.id === a).controls))].sort();
      const r = controlsForQuestion(c, q.id, []);
      expect([...ids(r.first), ...ids(r.rest)].sort(), q.id).toEqual(expected);
      expect(new Set([...ids(r.first), ...ids(r.rest)]).size, `${q.id} once each`).toBe(expected.length);
    }
  });
  it('FR-SUG-02: Q-PP-17 with Labeling bias ticked shows the unticked areas first and C-12 in the rest', () => {
    const r = controlsForQuestion(c, 'Q-PP-17', ['Labeling bias']);
    expect(r.first.map((g) => g.area.id)).toEqual(['PP-03', 'PP-04', 'PP-05']);
    expect(ids(r.first)).toEqual(['C-03', 'C-04', 'C-06', 'C-05', 'C-07', 'C-08']);
    expect(ids(r.rest)).toEqual(['C-12']);
  });
  it('FR-SUG-02: an unknown ticked option changes nothing', () => {
    expect(controlsForQuestion(c, 'Q-PP-17', ['Labeling bias', '<script>'])).toEqual(controlsForQuestion(c, 'Q-PP-17', ['Labeling bias']));
  });
  it('FR-SUG-02 FR-CNT-04: the gate shows none', () => {
    expect(controlsForQuestion(c, 'Q-PP-GATE-SENSITIVE', [])).toEqual({ first: [], rest: [] });
  });
  it('UX-13: on Q-IP-12, C-17 and C-19 appear once with Also addresses, and PO-07 is usually applied in post-processing', () => {
    const r = controlsForQuestion(c, 'Q-IP-12', []);
    expect(ids(r.first)).toEqual(['C-17', 'C-18', 'C-19', 'C-26', 'C-28']);
    expect(r.first[0].controls.find((x) => x.control.id === 'C-17')!.alsoAddresses).toEqual(['PO-07']);
    expect(r.first[1].controls.map((x) => x.usuallyAppliedIn)).toEqual(['post-processing', 'post-processing']);
  });
  it('FR-SUG-03: area IP-05 lists C-13, C-15, C-18', () => {
    expect(ids(controlsForArea(c, 'IP-05'))).toEqual(['C-13', 'C-15', 'C-18']);
    expect(controlsForArea(c, 'XX-99')).toEqual([]);
  });
});
