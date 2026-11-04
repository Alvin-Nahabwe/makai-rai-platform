import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AreasFile, DocumentHelpFile, LoadedContent, LoadedQuestion, QuestionBankFile, ReasonCodesFile,
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
  };
}
