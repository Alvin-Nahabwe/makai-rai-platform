import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * The structure of the versioned content directory (SRS 10.1.1, ADR-C9; contract "Content bundle").
 *
 * This file reads JSON with readFileSync only and imports nothing from lib/ or types/, so it
 * checks the committed files as they sit on disk. Counts and ids are read from the content
 * (call R-62), never written here. The id check against the 4.0.0 baseline at data/ is the
 * content checker's (validateContentVersion, a later CNT task).
 */
const json = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

/** Only the fields these checks read; the files are parsed here, not through lib/content. */
type Mapping = string | { area: string };
interface FileQuestion { id: string; type: string; gaps: string[]; optionGapMap?: Record<string, Mapping[]>; options?: string[]; condition?: { questionId: string; value: string } }
interface Question extends FileQuestion { stage: string }
interface Stage { modules: Array<{ questions: FileQuestion[] }> }
interface Area { id: string; controls: string[] }
interface Control { id: string; resources?: Array<{ url: string }> }
interface Code { code: string; status: string; label: string }

const C = 'data/content';
const idx = json(`${C}/index.json`);
const v = idx.running;
const qb = json(`${C}/${v}/questionBank.json`), aa = json(`${C}/${v}/assessmentAreas.json`);
const questions: Question[] = Object.entries(qb.stages as Record<string, Stage>).flatMap(([stage, s]) => s.modules.flatMap((m) => m.questions.map((q) => ({ ...q, stage }))));
const areasOf = (q: FileQuestion) => new Set([...q.gaps, ...Object.values(q.optionGapMap ?? {}).flat().map((e) => typeof e === 'string' ? e : e.area)]);

describe('content bundle structure', () => {
  it('FR-CNT-01: index lists the running version and every version directory holds its six files', () => {
    expect(idx.versions).toContain(v);
    for (const ver of idx.versions) for (const f of ['assessmentAreas.json', 'projectConfig.json', 'questionBank.json', 'reasonCodes.json', 'documentHelp.json', 'signoffs.json'])
      expect(existsSync(`${C}/${ver}/${f}`), `${ver}/${f}`).toBe(true);
  });
  it('FR-CNT-01: 3 stages, 6 modules, unique ids, counts read from the content (R-62)', () => {
    expect(Object.keys(qb.stages)).toEqual(['pre-processing', 'in-processing', 'post-processing']);
    expect(Object.values(qb.stages as Record<string, Stage>).flatMap((s) => s.modules)).toHaveLength(6);
    expect(new Set(questions.map((q) => q.id)).size).toBe(questions.length);
  });
  it('FR-CNT-01: 21 areas each mapped from a question, 28 controls each reachable, no dangling id', () => {
    expect(aa.areas).toHaveLength(21); expect(aa.controls).toHaveLength(28);
    const areaIds = new Set((aa.areas as Area[]).map((a) => a.id)), controlIds = new Set((aa.controls as Control[]).map((c) => c.id));
    const mapped = new Set(questions.flatMap((q) => [...areasOf(q)]));
    expect([...mapped].filter((a) => !areaIds.has(a))).toEqual([]);
    expect([...areaIds].filter((a) => !mapped.has(a))).toEqual([]);
    const reached = new Set((aa.areas as Area[]).filter((a) => mapped.has(a.id)).flatMap((a) => a.controls));
    expect([...reached].filter((c) => !controlIds.has(c))).toEqual([]);
    expect([...controlIds].filter((c) => !reached.has(c))).toEqual([]);
  });
  it('FR-CNT-06: no unlock rule, weight or scale; only gate-dependent questions keep a condition', () => {
    for (const q of questions) {
      expect(q).not.toHaveProperty('crossStageCondition'); expect(q).not.toHaveProperty('weight'); expect(q).not.toHaveProperty('scale');
      if (q.condition) expect(questions.find((g) => g.id === q.condition!.questionId)?.type).toBe('gate');
    }
    expect(Object.keys(qb)).toEqual(['meta', 'stages']);
  });
  it('FR-CNT-04 FR-CNT-03: the gate has no options and no mapping; conditions read value "yes"; checklists keep their options', () => {
    const gates = questions.filter((q) => q.type === 'gate');
    for (const g of gates) { expect(g.options).toBeUndefined(); expect(areasOf(g).size).toBe(0); }
    for (const q of questions.filter((q) => q.condition)) expect(q.condition!.value).toBe('yes');
    for (const q of questions.filter((q) => q.type === 'checklist')) expect(q.options!.length).toBeGreaterThan(0);
  });
  it('FR-CNT-01 FR-CNT-05: controls carry no notebook or template field; resources file outside every version directory', () => {
    for (const c of aa.controls as Control[]) { expect(c).not.toHaveProperty('notebook'); expect(c).not.toHaveProperty('template'); }
    expect(json('data/resources.json')).toEqual(expect.objectContaining({ templates: expect.any(Array), notebooks: expect.any(Array) }));
  });
  it('FR-CNT-01 NFR-SEC-11: every control resource link is https', () => {
    for (const c of aa.controls as Control[]) for (const r of c.resources ?? []) expect(new URL(r.url).protocol, `${c.id} ${r.url}`).toBe('https:');
  });
  it('FR-CNT-01 (QC-05): reason codes are coded by status and keep the platform and "other" codes', () => {
    const codes: Code[] = json(`${C}/${v}/reasonCodes.json`).codes;
    for (const c of codes) { expect(c.code).toMatch(/^(na|ny)_[a-z_]+$/); expect(c.status).toBe(c.code.startsWith('na_') ? 'not_applicable' : 'not_yet'); expect(c.label.length).toBeGreaterThan(0); }
    expect(codes.map((c) => c.code)).toEqual(expect.arrayContaining(['na_no_personal_data', 'na_other', 'ny_other']));
    expect(Object.keys(json(`${C}/${v}/documentHelp.json`)).sort()).toEqual(['data_card', 'mitigation_plan', 'model_card']);
  });
});
