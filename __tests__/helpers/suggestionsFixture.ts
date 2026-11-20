import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AreasFile, DocumentHelpFile, LoadedContent, LoadedQuestion, QuestionBankFile, ReasonCodesFile, ResourcesFile,
} from '@/types/content';
import { STAGES } from '@/types/record';

/**
 * Test code only. Builds a LoadedContent straight from the five content files of a bundle folder, so SUG's tests run
 * without the loader (the second root of the grouping rule's tests). `suggestions.test.ts` has a case that proves it
 * agrees with `loadContent`.
 */
const readJson = <T,>(dir: string, name: string): T => JSON.parse(readFileSync(join(dir, name), 'utf8')) as T;

export function handBuiltContent(dir: string): LoadedContent {
  const qb = readJson<QuestionBankFile>(dir, 'questionBank.json');
  const aa = readJson<AreasFile>(dir, 'assessmentAreas.json');
  const rc = readJson<ReasonCodesFile>(dir, 'reasonCodes.json');
  const dh = readJson<DocumentHelpFile>(dir, 'documentHelp.json');
  const questions = new Map<string, LoadedQuestion>();
  for (const stage of STAGES) {
    let order = 0;
    for (const m of qb.stages[stage].modules) {
      for (const q of m.questions) questions.set(q.id, { ...q, stage, moduleId: m.id, moduleTitle: m.title, order: order++ });
    }
  }
  return {
    semver: '0.0.1-fixture',
    contentHash: '',
    questions,
    areas: new Map(aa.areas.map((a) => [a.id, a])),
    controls: new Map(aa.controls.map((k) => [k.id, k])),
    reasonCodes: rc.codes,
    documentHelp: dh,
    stageApplicability: null,
    controlSuggestionsApproved: false,
  };
}

/** A literal resources file for the card and slot tests: Tasks 3 to 5 import it. C-13 has a released notebook, C-21 a failed one. */
export const RES = {
  templates: [{ controlId: 'C-01', file: '/templates/C-01_alternatives-analysis.html', kind: 'web page', bytes: 10240, sha256: 'c'.repeat(64), review: { reviewer: 'r', date: '2026-10-30', outcome: 'passed' } },
              { controlId: 'C-02', file: '/templates/C-02_cost-benefit-impact.html', kind: 'web page', bytes: 9000, sha256: 'd'.repeat(64), review: { reviewer: 'r', date: '2026-10-30', outcome: 'failed' } }],
  notebooks: [{ controlId: 'C-13', file: '/notebooks/C-13_subgroup-fairness.ipynb', requirementsFile: '/notebooks/requirements.txt', sha256: 'a'.repeat(64), bytes: 48000, review: { reviewer: 'Reviewer A', date: '2026-10-31', outcome: 'passed' }, released: true },
              { controlId: 'C-21', file: '/notebooks/C-21_monitoring-drift.ipynb', requirementsFile: '/notebooks/requirements.txt', sha256: 'b'.repeat(64), bytes: 40000, review: { reviewer: 'Reviewer A', date: '2026-10-31', outcome: 'failed' }, released: false }],
} satisfies ResourcesFile;
