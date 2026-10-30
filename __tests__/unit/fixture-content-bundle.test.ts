import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AreasFile, ContentIndexFile, ContentQuestion, QuestionBankFile, ReasonCodesFile } from '@/types/content';
import { computeVersionBundleHash } from '@/lib/content/bundleHash';
import { contentRoot, readContentBytes, readContentIndex, runningSemver } from '@/lib/content/root';
import { readContentBytes as readByRelativePath } from '../../lib/content/root';
import { FIXTURE_QUESTION_IDS } from '../helpers/content';

/**
 * G-17 (unit H0). The fixture content bundle under __tests__/fixtures/content holds the 78 question ids of
 * v0.5.0, so no test that names a question id depends on which ids the question-set revision keeps. These
 * tests read the committed files; they do not run the generator.
 */

const ROOT = join(process.cwd(), '__tests__', 'fixtures', 'content');
const VERSIONS = ['0.0.1-fixture', '0.0.2-fixture'] as const;

/**
 * The 78 ids of v0.5.0, in file order (data/questionBank.json at d13be0c, content version 4.0.0). Frozen
 * here on purpose: the fixture must not follow the question-set revision, and the live file will change.
 */
const V050_IDS = [
  'Q-PP-01', 'Q-PP-02', 'Q-PP-03', 'Q-PP-04', 'Q-PP-05', 'Q-PP-06', 'Q-PP-07', 'Q-PP-08', 'Q-PP-09',
  'Q-PP-10', 'Q-PP-11', 'Q-PP-12', 'Q-PP-GATE-SENSITIVE', 'Q-PP-13', 'Q-PP-14', 'Q-PP-15', 'Q-PP-16',
  'Q-PP-17', 'Q-PP-18', 'Q-PP-19', 'Q-PP-20', 'Q-PP-21', 'Q-PP-22', 'Q-PP-23', 'Q-IP-01', 'Q-IP-02',
  'Q-IP-03', 'Q-IP-04', 'Q-IP-05', 'Q-IP-06', 'Q-IP-07', 'Q-IP-08', 'Q-IP-16', 'Q-IP-17', 'Q-IP-18',
  'Q-IP-09', 'Q-IP-10', 'Q-IP-11', 'Q-IP-12', 'Q-IP-13', 'Q-IP-14', 'Q-IP-15', 'Q-IP-19', 'Q-IP-20',
  'Q-IP-21', 'Q-IP-22', 'Q-IP-23', 'Q-IP-24', 'Q-IP-EXTRA-01', 'Q-IP-EXTRA-02', 'Q-PO-01', 'Q-PO-02',
  'Q-PO-03', 'Q-PO-04', 'Q-PO-05', 'Q-PO-06', 'Q-PO-07', 'Q-PO-16', 'Q-PO-17', 'Q-PO-18', 'Q-PO-19',
  'Q-PO-08', 'Q-PO-09', 'Q-PO-10', 'Q-PO-11', 'Q-PO-12', 'Q-PO-13', 'Q-PO-14', 'Q-PO-15', 'Q-PO-20',
  'Q-PO-21', 'Q-PO-22', 'Q-PO-23', 'Q-PO-24', 'Q-PO-EXTRA-01', 'Q-PO-EXTRA-02', 'Q-PO-EXTRA-03',
  'Q-PO-EXTRA-04',
];

const read = <T>(version: string, file: string): T => JSON.parse(readFileSync(join(ROOT, version, file), 'utf8')) as T;
const all = (version: string): ContentQuestion[] =>
  Object.values(read<QuestionBankFile>(version, 'questionBank.json').stages)
    .flatMap((s) => s.modules)
    .flatMap((m) => m.questions);
const byId = (version: string): Record<string, ContentQuestion> => Object.fromEntries(all(version).map((q) => [q.id, q]));
const idsOf = (version: string): string[] => all(version).map((q) => q.id);
const areas = (version: string): AreasFile => read<AreasFile>(version, 'assessmentAreas.json');
const reasonCodes = (version: string): ReasonCodesFile => read<ReasonCodesFile>(version, 'reasonCodes.json');
const sentences = (s: string): number => s.split(/[.!?]+(?:\s+|$)/).filter((p) => p.trim() !== '').length;

/** `<question id>.<field>` for every field whose value differs between two versions of the question bank. */
function diffPaths(a: string, b: string): string[] {
  const qa = byId(a);
  const qb = byId(b);
  const paths: string[] = [];
  for (const id of new Set([...Object.keys(qa), ...Object.keys(qb)])) {
    const left = (qa[id] ?? {}) as unknown as Record<string, unknown>;
    const right = (qb[id] ?? {}) as unknown as Record<string, unknown>;
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
      if (JSON.stringify(left[key]) !== JSON.stringify(right[key])) paths.push(`${id}.${key}`);
  }
  return paths;
}

describe('the fixture content bundle', () => {
  it('G-17: both fixture versions hold the 78 v0.5.0 question ids', () => {
    expect(V050_IDS).toHaveLength(78);
    expect(new Set(V050_IDS).size).toBe(78);
    for (const v of VERSIONS) expect(idsOf(v)).toEqual(V050_IDS);
    expect(read<QuestionBankFile>('0.0.1-fixture', 'questionBank.json').meta).toMatchObject({ version: '0.0.1-fixture', totalQuestions: 78 });
    expect(FIXTURE_QUESTION_IDS).toEqual(V050_IDS);
    expect(FIXTURE_QUESTION_IDS).toHaveLength(78);
  });

  it('FR-CNT-04 FR-CNT-06: the gate and the conditions are in the 5.0.0 shape', () => {
    for (const v of VERSIONS) {
      const q = byId(v);
      expect(q['Q-IP-06'].condition).toBeUndefined(); // v0.5.0 had { questionId: 'Q-IP-05', minValue: 1 }
      expect(q['Q-PP-13'].condition).toEqual({ questionId: 'Q-PP-GATE-SENSITIVE', value: 'yes' });
      expect(q['Q-PP-14'].condition).toEqual({ questionId: 'Q-PP-GATE-SENSITIVE', value: 'yes' });
      expect(q['Q-PP-GATE-SENSITIVE'].type).toBe('gate');
      expect(q['Q-PP-GATE-SENSITIVE'].options).toBeUndefined(); // v0.5.0 had ['Yes', 'No']
      expect(all(v).filter((x) => x.condition).map((x) => x.id)).toEqual(['Q-PP-13', 'Q-PP-14']);
    }
  });

  it('FR-CNT-03 (harness): the five checklist questions keep their options and their option-to-area map', () => {
    const q = byId('0.0.1-fixture');
    for (const id of ['Q-PP-16', 'Q-PP-17', 'Q-IP-06', 'Q-IP-13', 'Q-PO-11']) {
      expect(q[id].type, id).toBe('checklist');
      expect(q[id].options?.length, id).toBeGreaterThan(1);
      expect(Object.keys(q[id].optionGapMap ?? {}).sort(), id).toEqual([...(q[id].options ?? [])].sort());
    }
    expect(all('0.0.1-fixture').filter((x) => x.type === 'checklist')).toHaveLength(5);
  });

  it('FR-CNT-02 (harness): every fixture question carries the four texts within their limits', () => {
    for (const v of VERSIONS)
      for (const q of all(v)) {
        expect(q.expectedPractice.length, q.id).toBeGreaterThanOrEqual(40);
        expect(q.expectedPractice.length, q.id).toBeLessThanOrEqual(400);
        expect(q.whyAsked.length, q.id).toBeLessThanOrEqual(300);
        expect(sentences(q.whyAsked), q.id).toBeLessThanOrEqual(2);
        expect(q.reasonPrompt.length, q.id).toBeLessThanOrEqual(400);
        expect(sentences(q.reasonPrompt), q.id).toBeLessThanOrEqual(4);
        expect(q.evidenceExamples.length, q.id).toBeGreaterThanOrEqual(1);
        expect(q.evidenceExamples.length, q.id).toBeLessThanOrEqual(4);
      }
  });

  it('FR-CNT-07 FR-CNT-08 (harness): 0.0.2-fixture differs from 0.0.1-fixture only in the text and expected practice of three questions', () => {
    expect(diffPaths('0.0.1-fixture', '0.0.2-fixture').sort()).toEqual([
      'Q-IP-05.expectedPractice',
      'Q-IP-05.text',
      'Q-PP-01.expectedPractice',
      'Q-PP-01.text',
      'Q-PP-12.expectedPractice',
      'Q-PP-12.text',
    ]);
  });

  it('FR-CNT-07 FR-CNT-08 (harness): the other files differ only in meta.version, and the two content hashes differ', () => {
    for (const f of ['projectConfig.json', 'reasonCodes.json', 'documentHelp.json', 'signoffs.json'])
      expect(readFileSync(join(ROOT, '0.0.2-fixture', f)).equals(readFileSync(join(ROOT, '0.0.1-fixture', f))), f).toBe(true);
    const a1 = areas('0.0.1-fixture');
    const a2 = areas('0.0.2-fixture');
    expect(a1.meta.version).toBe('0.0.1-fixture');
    expect(a2.meta.version).toBe('0.0.2-fixture');
    expect({ ...a2, meta: { ...a2.meta, version: a1.meta.version } }).toEqual(a1);
    expect(computeVersionBundleHash(join(ROOT, '0.0.1-fixture'))).not.toBe(computeVersionBundleHash(join(ROOT, '0.0.2-fixture')));
  });

  it('G-17: 21 areas, 28 controls without notebook or template, 14 reason codes', () => {
    const a = areas('0.0.1-fixture');
    expect(a.areas).toHaveLength(21);
    expect(a.controls).toHaveLength(28);
    for (const c of a.controls) {
      expect(c).not.toHaveProperty('notebook');
      expect(c).not.toHaveProperty('template');
    }
    expect(reasonCodes('0.0.1-fixture').codes.map((c) => c.code)).toEqual([
      'na_no_personal_data',
      'na_no_people_affected',
      'na_no_deployment',
      'na_not_this_kind_of_system',
      'na_answered_elsewhere',
      'na_other',
      'ny_planned_later',
      'ny_awaiting_ethics',
      'ny_awaiting_data_access',
      'ny_awaiting_partner',
      'ny_needs_resources',
      'ny_needs_skills',
      'ny_first_considered',
      'ny_other',
    ]); // SRS lines 3986-3999
    for (const c of reasonCodes('0.0.1-fixture').codes) expect(c.status).toBe(c.code.startsWith('na_') ? 'not_applicable' : 'not_yet');
  });

  it('FR-CNT-01 (harness): the fixture mapping has no dangling reference', () => {
    const a = areas('0.0.1-fixture');
    const areaIds = new Set(a.areas.map((x) => x.id));
    const controlIds = new Set(a.controls.map((x) => x.id));
    for (const area of a.areas) for (const c of area.controls ?? []) expect(controlIds.has(c), `${area.id} -> ${c}`).toBe(true);
    for (const q of all('0.0.1-fixture')) {
      for (const g of q.gaps) expect(areaIds.has(g), `${q.id} gap ${g}`).toBe(true);
      for (const mapped of Object.values(q.optionGapMap ?? {}))
        for (const m of mapped) expect(areaIds.has(typeof m === 'string' ? m : m.area), `${q.id} option map ${JSON.stringify(m)}`).toBe(true);
    }
  });

  it('FR-CNT-01 (harness): the index lists both versions and runs 0.0.1-fixture', () => {
    expect(JSON.parse(readFileSync(join(ROOT, 'index.json'), 'utf8')) as ContentIndexFile).toEqual({
      running: '0.0.1-fixture',
      versions: ['0.0.1-fixture', '0.0.2-fixture'],
    });
  });
});

describe('the vitest setup file', () => {
  it('G-17: the setup file points all four content-root functions at the fixture bundle', () => {
    expect(contentRoot()).toMatch(/__tests__\/fixtures\/content$/);
    expect(runningSemver()).toBe('0.0.1-fixture');
    expect(readContentIndex().running).toBe('0.0.1-fixture');
    expect(readContentBytes('0.0.2-fixture', 'questionBank.json').equals(readFileSync(join(contentRoot(), '0.0.2-fixture', 'questionBank.json')))).toBe(true);
  });

  it('G-17: the mock applies to a module that imports the content root by a relative path', () => {
    // The loader imports './root'; the setup file mocks '@/lib/content/root'. Both must be the same module,
    // or this read would go to data/content/, which holds no 0.0.1-fixture.
    expect(readByRelativePath('0.0.1-fixture', 'reasonCodes.json').equals(readContentBytes('0.0.1-fixture', 'reasonCodes.json'))).toBe(true);
  });

  it('G-17: the mock refuses a path-like semver or file name as the real module does', () => {
    expect(() => readContentBytes('0.0.1-fixture', '../index.json')).toThrow(/content path/);
    expect(() => readContentBytes('../..', 'package.json')).toThrow(/content path/);
  });
});
