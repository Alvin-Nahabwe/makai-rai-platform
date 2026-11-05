import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FieldMap, FieldMapEntry, FieldSource } from '@/types/documents';
import { DOCUMENT_TYPES, type DocumentType } from '@/types/record';
import type { FieldRepoint, QuestionBankFile } from '@/types/content';

const PROJECT_FIELDS = ['fundingSource', 'datasetDescription', 'datasetSize', 'datasetType', 'country',
  'processesPersonalData', 'institution', 'department', 'aiSystemType', 'deploymentSector'] as const; // SRS 10.3.2, 10.3.3

// The phrase pattern of FR-PUB-01 (SRS line 1103).
const PHRASES = /\bcomplian(ce|t)\b|\baudit(-ready| ready|ed)\b|aligned (to|with)\b|\bcertif(y|ied|ication)\b|\baccredit|\bscores?\b|cannot see your records/i;

// The nine source forms of the contract's `FieldSource` and the values each may hold (SRS 10.3.1).
const KINDS = ['record', 'record_option', 'findings', 'mitigations', 'accepted_risks', 'project', 'typed', 'meta', 'mapping'];
const PARTS = ['status', 'reason', 'options', 'evidence', 'scope'];
const STAGES = ['pre-processing', 'in-processing', 'post-processing', 'review'];
const FINDING_FILTERS = ['all', 'open', 'open_and_closed', 'closed_by_mitigation', 'counts'];
const MITIGATION_FILTERS = ['current', 'done', 'counts'];
const META_ITEMS = ['seals', 'deciders', 'no_decision', 'not_applicable', 'review'];

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8');
const readMap = (t: DocumentType): FieldMap => JSON.parse(read(`data/fieldmaps/${t}.json`)) as FieldMap;
const readBaseline = (t: DocumentType): FieldMap => JSON.parse(read(`__tests__/fixtures/fieldmaps/0.5.0/${t}.json`)) as FieldMap;
const FIXTURE_BANK = '__tests__/fixtures/content/0.0.1-fixture/questionBank.json';
const REPOINTS = 'docs/content/fieldmaps/repoints-5.0.0.json';

const namesQuestion = (s: FieldSource, questionId: string): boolean =>
  (s.kind === 'record' || s.kind === 'record_option') && s.questionId === questionId;

/** Joins record sources that read the same question into the first of them, parts merged in order of first use. */
const joinRecordSources = (sources: FieldSource[]): FieldSource[] => {
  const out: FieldSource[] = [];
  for (const s of sources) {
    if (s.kind !== 'record') { out.push(s); continue; }
    const kept = out.find((o) => o.kind === 'record' && o.questionId === s.questionId);
    if (kept && kept.kind === 'record') kept.parts = [...kept.parts, ...s.parts.filter((p) => !kept.parts.includes(p))];
    else out.push({ ...s, parts: [...s.parts] });
  }
  return out;
};

/**
 * The CW-11b rule: a re-point to a question replaces `questionId: from` by `to` (parts and option kept), then
 * joins two record sources of one question into one; `typed_only` removes the sources naming `from` and appends
 * a typed source unless one remains.
 */
const applyRepoints = (map: FieldMap, repoints: FieldRepoint[]): FieldMap => {
  const out = structuredClone(map);
  for (const r of repoints) {
    const field = out.fields.find((f) => f.fieldId === r.fieldId);
    if (!field) throw new Error(`${r.documentType}: re-point names ${r.fieldId}, which the baseline lacks`);
    if (r.to === 'typed_only') {
      field.sources = field.sources.filter((s) => !namesQuestion(s, r.from));
      if (!field.sources.some((s) => s.kind === 'typed')) field.sources.push({ kind: 'typed' });
    } else {
      const to = r.to;
      field.sources = joinRecordSources(field.sources.map((s) => (namesQuestion(s, r.from) ? { ...s, questionId: to } as FieldSource : s)));
    }
  }
  return out;
};

/** Collapses runs of equal values; a value that comes back after another one stays in the list twice, so a split section shows. */
const distinctInOrder = (xs: string[]): string[] => xs.filter((x, i) => i === 0 || x !== xs[i - 1]);

/**
 * The rule of SRS 10.3.7 as the SRS generator applied it: a field counts as typed only when its kinds are
 * only `typed` (a `typedAddition: true` field has `typed` among its kinds); otherwise as the first of
 * record, findings, project, meta that it has. The flag moves no count (a field with other kinds keeps its
 * bucket), so the typed-additions assertion below is what pins it.
 */
const countKinds = (map: FieldMap): { total: number; record: number; findings: number; project: number; meta: number; typedOnly: number } => {
  const c = { total: 0, record: 0, findings: 0, project: 0, meta: 0, typedOnly: 0 };
  for (const f of map.fields) {
    const kinds = new Set<string>();
    for (const s of f.sources) {
      if (s.kind === 'record' || s.kind === 'record_option') kinds.add('record');
      else if (s.kind === 'findings' || s.kind === 'mitigations' || s.kind === 'accepted_risks' || s.kind === 'mapping') kinds.add('findings');
      else if (s.kind === 'project') kinds.add('project');
      else if (s.kind === 'meta') kinds.add('meta');
      else if (s.kind === 'typed') kinds.add('typed'); // any other kind is rejected by the source-forms test
    }
    if (f.typedAddition) kinds.add('typed');
    c.total += 1;
    if (kinds.size === 1 && kinds.has('typed')) c.typedOnly += 1;
    else if (kinds.has('record')) c.record += 1;
    else if (kinds.has('findings')) c.findings += 1;
    else if (kinds.has('project')) c.project += 1;
    else if (kinds.has('meta')) c.meta += 1;
  }
  return c;
};

const ids = (prefix: string, from: number, to: number): string[] =>
  Array.from({ length: to - from + 1 }, (_, i) => `${prefix}-${String(from + i).padStart(2, '0')}`);

/** Field ids grouped by consecutive section, in file order. */
const fieldsBySection = (map: FieldMap): Array<[string, string[]]> => {
  const out: Array<[string, string[]]> = [];
  for (const f of map.fields) {
    const last = out[out.length - 1];
    if (last && last[0] === f.section) last[1].push(f.fieldId);
    else out.push([f.section, [f.fieldId]]);
  }
  return out;
};

const allSources = (map: FieldMap): FieldSource[] => map.fields.flatMap((f: FieldMapEntry) => f.sources);

describe('CW-11 field maps: structure', () => {
  it('CW-11 FR-DOC-01: one file per document type, homeStage as 10.3 headings', () => {
    for (const t of DOCUMENT_TYPES) expect(readMap(t).documentType).toBe(t);
    expect(readMap('data_card').homeStage).toBe('pre-processing');
    expect(readMap('model_card').homeStage).toBe('in-processing');
    expect(readMap('mitigation_plan').homeStage).toBe('review');
  });

  it('CW-11 FR-DOC-02: every field has at least one source and a unique id', () => {
    for (const t of DOCUMENT_TYPES) {
      const { fields } = readMap(t);
      expect(fields.length, t).toBeGreaterThan(0);
      for (const f of fields) expect(f.sources.length, `${t} ${f.fieldId}`).toBeGreaterThan(0);
      expect(new Set(fields.map((f) => f.fieldId)).size, t).toBe(fields.length);
    }
  });

  it('CW-11 FR-DOC-02: every field and source has exactly the keys and values of the contract form', () => {
    const keysOf = (o: object, required: string[], optional: string[], where: string): void => {
      const keys = Object.keys(o);
      expect(required.filter((k) => !keys.includes(k)), `${where} missing keys`).toEqual([]);
      expect(keys.filter((k) => !required.includes(k) && !optional.includes(k)), `${where} extra keys`).toEqual([]);
    };
    const text = (v: unknown, where: string): void => {
      expect(typeof v === 'string' && v.trim().length > 0, `${where} is a non-empty string`).toBe(true);
    };
    for (const t of DOCUMENT_TYPES) {
      const map = readMap(t);
      keysOf(map, ['documentType', 'homeStage', 'templateVersion', 'fields'], [], t);
      expect(map.templateVersion, `${t} templateVersion`).toBe('5.0.0'); // ASSUMPTION of the CW-11 brief: the SRS fixes no value
      for (const f of map.fields) {
        const at = `${t} ${f.fieldId}`;
        keysOf(f, ['fieldId', 'label', 'section', 'sources', 'typedAddition'], [], at);
        text(f.fieldId, `${at} fieldId`); text(f.label, `${at} label`); text(f.section, `${at} section`);
        expect(typeof f.typedAddition, `${at} typedAddition`).toBe('boolean');
        expect(Array.isArray(f.sources), `${at} sources is an array`).toBe(true);
        for (const s of f.sources) {
          expect(KINDS, `${at} kind ${String(s.kind)}`).toContain(s.kind);
          switch (s.kind) {
            case 'record':
              keysOf(s, ['kind', 'questionId', 'parts'], [], at); text(s.questionId, `${at} questionId`);
              expect(Array.isArray(s.parts) && s.parts.length > 0, `${at} parts is a non-empty array`).toBe(true);
              expect(new Set(s.parts).size, `${at} parts repeat`).toBe(s.parts.length);
              for (const p of s.parts) expect(PARTS, `${at} part ${String(p)}`).toContain(p);
              break;
            case 'record_option':
              keysOf(s, ['kind', 'questionId', 'option'], [], at); text(s.questionId, `${at} questionId`); text(s.option, `${at} option`);
              break;
            case 'findings':
              keysOf(s, ['kind', 'stage', 'filter'], ['areas'], at);
              expect(STAGES, `${at} stage`).toContain(s.stage); expect(FINDING_FILTERS, `${at} filter`).toContain(s.filter);
              if ('areas' in s) {
                expect(Array.isArray(s.areas) && (s.areas as unknown[]).length > 0, `${at} areas is a non-empty array`).toBe(true);
                for (const a of s.areas ?? []) text(a, `${at} area`);
              }
              break;
            case 'mitigations':
              keysOf(s, ['kind', 'stage', 'filter'], [], at);
              expect(STAGES, `${at} stage`).toContain(s.stage); expect(MITIGATION_FILTERS, `${at} filter`).toContain(s.filter);
              break;
            case 'accepted_risks':
              keysOf(s, ['kind', 'stage'], [], at); expect(STAGES, `${at} stage`).toContain(s.stage);
              break;
            case 'project':
              keysOf(s, ['kind', 'field'], [], at); text(s.field, `${at} field`);
              break;
            case 'typed':
              keysOf(s, ['kind'], ['structured'], at);
              if ('structured' in s) expect(s.structured, `${at} structured`).toBe('ethics_approval');
              break;
            case 'meta':
              keysOf(s, ['kind', 'item'], [], at); expect(META_ITEMS, `${at} item`).toContain(s.item);
              break;
            case 'mapping':
              keysOf(s, ['kind'], [], at);
              break;
          }
        }
      }
    }
  });

  it('CW-11 FR-DOC-02: project fields are the ten 10.3 names and exist on ProjectMetadata', () => {
    const schema = read('prisma/schema.prisma');
    const model = /model ProjectMetadata \{([\s\S]*?)\n\}/.exec(schema);
    expect(model, 'model ProjectMetadata in prisma/schema.prisma').not.toBeNull();
    const columns = new Set(
      model![1].split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^[a-z][A-Za-z0-9]*$/.test(n)),
    );
    const used = new Set<string>();
    for (const t of DOCUMENT_TYPES) {
      for (const s of allSources(readMap(t))) {
        if (s.kind !== 'project') continue;
        expect((PROJECT_FIELDS as readonly string[]).includes(s.field), `${t}: ${s.field}`).toBe(true);
        expect(columns.has(s.field), `ProjectMetadata.${s.field}`).toBe(true);
        used.add(s.field);
      }
    }
    // All ten names are read by some map; none is dropped or renamed.
    expect([...used].sort()).toEqual([...PROJECT_FIELDS].sort());
  });

  it('CW-11 FR-DOC-05: record sources carry no stage field', () => {
    for (const t of DOCUMENT_TYPES) {
      for (const s of allSources(readMap(t))) {
        if (s.kind === 'record') expect(Object.keys(s).sort(), `${t} ${s.questionId}`).toEqual(['kind', 'parts', 'questionId']);
        if (s.kind === 'record_option') expect(Object.keys(s).sort(), `${t} ${s.questionId}`).toEqual(['kind', 'option', 'questionId']);
      }
    }
  });

  it('CW-11: record parts are valid for the question type in the fixture bundle', () => {
    const bank = JSON.parse(read(FIXTURE_BANK)) as QuestionBankFile;
    const byId = new Map(
      Object.values(bank.stages).flatMap((st) => st.modules.flatMap((m) => m.questions.map((q) => [q.id, q] as const))),
    );
    const total = Object.values(bank.stages).reduce((n, st) => n + st.modules.reduce((m, mod) => m + mod.questions.length, 0), 0);
    expect(byId.size, 'a question id repeats in the fixture bundle').toBe(total);
    for (const t of DOCUMENT_TYPES) {
      for (const s of allSources(readMap(t))) {
        if (s.kind !== 'record' && s.kind !== 'record_option') continue;
        const q = byId.get(s.questionId);
        expect(q, `${t}: ${s.questionId} is in the fixture bundle`).toBeDefined();
        if (s.kind === 'record') {
          if (s.parts.includes('scope')) expect(q!.type, `${t} ${s.questionId} scope`).toBe('gate');
          if (s.parts.includes('options')) expect(q!.type, `${t} ${s.questionId} options`).toBe('checklist');
        } else {
          expect(q!.type, `${t} ${s.questionId} option`).toBe('checklist');
          expect(q!.options, `${t} ${s.questionId}`).toContain(s.option);
        }
      }
    }
  });
});

describe('CW-11 field maps: transcription of SRS 10.3', () => {
  it('CW-11 FR-DOC-02: field ids and order equal SRS 10.3', () => {
    expect(readMap('data_card').fields.map((f) => f.fieldId)).toEqual([
      'DC-01', 'DC-02', 'DC-03', 'DC-04', 'DC-05', 'DC-06', 'DC-07', 'DC-08', 'DC-09', 'DC-10', 'DC-11', 'DC-12', 'DC-13',
      'DC-14', 'DC-15', 'DC-16', 'DC-35', 'DC-17', 'DC-18', 'DC-19', 'DC-20', 'DC-21', 'DC-22', 'DC-23', 'DC-24', 'DC-25',
      'DC-26', 'DC-27', 'DC-28', 'DC-29', 'DC-30', 'DC-31', 'DC-32', 'DC-33', 'DC-34']);
    expect(readMap('model_card').fields.map((f) => f.fieldId)).toEqual([
      'MC-01', 'MC-02', 'MC-03', 'MC-04', 'MC-05', 'MC-06', 'MC-07', 'MC-08', 'MC-09', 'MC-10', 'MC-11', 'MC-12', 'MC-13',
      'MC-14', 'MC-15', 'MC-16', 'MC-17', 'MC-18', 'MC-19', 'MC-20', 'MC-21', 'MC-22', 'MC-23', 'MC-24', 'MC-25', 'MC-26',
      'MC-27', 'MC-28', 'MC-33', 'MC-29', 'MC-30', 'MC-31', 'MC-32']);
    expect(readMap('mitigation_plan').fields.map((f) => f.fieldId)).toEqual([
      'MP-01', 'MP-02', 'MP-03', 'MP-04', 'MP-06', 'MP-05', 'MP-07', 'MP-08', 'MP-09', 'MP-10']);
  });

  it('CW-11 FR-DOC-02: sections in 10.3 order', () => {
    expect(distinctInOrder(readMap('data_card').fields.map((f) => f.section))).toEqual(['Motivation', 'Composition',
      'Collection process', 'Preprocessing and labelling', 'Uses and restrictions', 'Distribution and maintenance', 'Record and sign-off']);
    expect(distinctInOrder(readMap('model_card').fields.map((f) => f.section))).toEqual(['Model details', 'Intended use',
      'Training and evaluation data', 'Performance', 'Ethical considerations', 'Limitations and recommendations',
      'Environmental impact', 'Record and sign-off']);
    expect(distinctInOrder(readMap('mitigation_plan').fields.map((f) => f.section))).toEqual(['Scope',
      'Remaining risks: open findings and accepted risks', 'Findings closed by a mitigation',
      'Gaps the reader should know about', 'Notes and sign-off']);
  });

  it('CW-11 FR-DOC-02: each field sits in the section 10.3 gives it', () => {
    // The order test above cannot see one field moved into the section next to its own; this one can.
    expect(fieldsBySection(readMap('data_card'))).toEqual([
      ['Motivation', ids('DC', 1, 3)], ['Composition', ids('DC', 4, 10)],
      ['Collection process', [...ids('DC', 11, 16), 'DC-35']], ['Preprocessing and labelling', ids('DC', 17, 20)],
      ['Uses and restrictions', ids('DC', 21, 23)], ['Distribution and maintenance', ids('DC', 24, 30)],
      ['Record and sign-off', ids('DC', 31, 34)]]);
    expect(fieldsBySection(readMap('model_card'))).toEqual([
      ['Model details', ids('MC', 1, 8)], ['Intended use', ids('MC', 9, 11)], ['Training and evaluation data', ids('MC', 12, 17)],
      ['Performance', ids('MC', 18, 20)], ['Ethical considerations', ids('MC', 21, 25)],
      ['Limitations and recommendations', ids('MC', 26, 28)], ['Environmental impact', ['MC-33']],
      ['Record and sign-off', ids('MC', 29, 32)]]);
    expect(fieldsBySection(readMap('mitigation_plan'))).toEqual([
      ['Scope', ids('MP', 1, 2)], ['Remaining risks: open findings and accepted risks', ['MP-03', 'MP-04', 'MP-06']],
      ['Findings closed by a mitigation', ['MP-05']], ['Gaps the reader should know about', ids('MP', 7, 8)],
      ['Notes and sign-off', ids('MP', 9, 10)]]);
  });

  it('CW-11b FR-DOC-02: kind counts of the final maps, re-derived from the approved set (SRS 10.3.7, line 4285)', () => {
    // SRS 10.3.7 gives data card 35/15/0/6/2/12 for v0.5.0; the DC-31 re-point to typed only moves one field from record to typed only.
    expect(countKinds(readMap('data_card'))).toEqual({ total: 35, record: 14, findings: 0, project: 6, meta: 2, typedOnly: 13 });
    expect(countKinds(readMap('model_card'))).toEqual({ total: 33, record: 19, findings: 2, project: 2, meta: 2, typedOnly: 8 });
    expect(countKinds(readMap('mitigation_plan'))).toEqual({ total: 10, record: 0, findings: 5, project: 0, meta: 4, typedOnly: 1 });
  });

  it('CW-11 FR-DOC-02: the fields that allow a typed addition are those 10.3 marks', () => {
    const marked = (t: DocumentType): string[] => readMap(t).fields.filter((f) => f.typedAddition).map((f) => f.fieldId);
    expect(marked('data_card')).toEqual(['DC-03', 'DC-04', 'DC-06', 'DC-09', 'DC-14', 'DC-23', 'DC-29']);
    expect(marked('model_card')).toEqual(['MC-03', 'MC-27']);
    expect(marked('mitigation_plan')).toEqual([]);
  });

  it('CW-11 FR-PUB-01: no field label matches the phrase pattern', () => {
    for (const t of DOCUMENT_TYPES) {
      for (const f of readMap(t).fields) expect(PHRASES.test(f.label), `${t} ${f.fieldId}: ${f.label}`).toBe(false);
    }
  });
});

describe('CW-11b field maps: the approved re-point list', () => {
  const repoints = JSON.parse(read(REPOINTS)) as FieldRepoint[];

  it('CW-11b FR-DOC-02: final maps equal the baseline with the approved re-points and nothing else', () => {
    for (const t of DOCUMENT_TYPES) {
      expect(readMap(t), t).toEqual(applyRepoints(readBaseline(t), repoints.filter((r) => r.documentType === t)));
    }
  });

  it('CW-11b: no re-point names a field or a from-question the baseline lacks', () => {
    expect(repoints.length, 'the approved list is empty').toBeGreaterThan(0);
    for (const r of repoints) {
      expect(DOCUMENT_TYPES, `${r.fieldId} documentType`).toContain(r.documentType);
      const field = readBaseline(r.documentType).fields.find((f) => f.fieldId === r.fieldId);
      expect(field, `${r.documentType} ${r.fieldId} is in the baseline`).toBeDefined();
      expect(field!.sources.some((s) => namesQuestion(s, r.from)), `${r.fieldId} reads ${r.from} in the baseline`).toBe(true);
    }
  });

  it('CW-11b: no field reads one question through two record sources', () => {
    for (const t of DOCUMENT_TYPES) {
      for (const f of readMap(t).fields) {
        const qs = f.sources.flatMap((s) => (s.kind === 'record' ? [s.questionId] : []));
        expect(new Set(qs).size, `${t} ${f.fieldId}: ${qs.join(', ')}`).toBe(qs.length);
      }
    }
  });
});
