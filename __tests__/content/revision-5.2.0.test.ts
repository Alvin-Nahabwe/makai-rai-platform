/**
 * Content 5.2.0 is a draft for the owner's sittings (per-question wording): 5.1.0 plus the changes in
 * `docs/content/question-set-5.2.0/changes.json`, with `meta.version` 5.2.0. 5.1.0 stays the running version and nothing
 * here is signed (`data/content/5.2.0/signoffs.json` holds no record).
 *
 * `changes.json` is the single source, in the row format of 5.1.0's: `{ row, id, file, field, from, to, decision, final }`.
 * A field may be a path inside the holder (`answerLabels.done`); `from` is the 5.1.0 value, or null where 5.1.0 has none;
 * `to`/`final` null removes the field (the reason prompt of a question that gets answer prompts).
 *
 * The three stages are drafted one at a time. List a stage in DRAFTED_STAGES when its content lands; the checks that need
 * wording run for the listed stages, and the whole-version checks run once all three are listed. No failing test is committed:
 * with the list empty only the two checks that hold for any 5.2.0 (equals 5.1.0 plus the rows; no mapping change) and the
 * completeness check run.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { sentenceCount, validateContentVersion } from '@/lib/content/validate';
import { STAGES, type Stage } from '@/types/record';
import { loadContentFrom, questionWords } from '../../scripts/content/question-words.mjs';

import { withApprovedCopy } from './helpers/draft-proposal';

const OLD = 'data/content/5.1.0';
const OLDER = 'data/content/5.0.0';
const NEW = 'data/content/5.2.0';
const CHANGES_FILE = 'docs/content/question-set-5.2.0/changes.json';
const PROPOSAL_FILE = 'docs/content/question-set-5.2.0/proposal.json';
const FILES = ['assessmentAreas.json', 'projectConfig.json', 'questionBank.json', 'reasonCodes.json', 'documentHelp.json'] as const;
type FileName = (typeof FILES)[number];
const KEYS = ['done', 'partly', 'not_yet', 'not_applicable'] as const;
const GATE = 'Q-PP-GATE-SENSITIVE';

/** The stages whose 5.2.0 content is drafted. The stage dispatches add to it. */
const DRAFTED_STAGES: readonly Stage[] = ['pre-processing', 'in-processing', 'post-processing'];

interface Change { row: string; id: string; file: FileName; field: string; from: unknown; to: unknown; decision: 'pending' | 'accept' | 'edit' | 'decline'; final: unknown }
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- walks arbitrary content JSON

const read = (dir: string, f: string): Json => JSON.parse(readFileSync(`${dir}/${f}`, 'utf8'));
const readBundle = (dir: string): Record<FileName, Json> => Object.fromEntries(FILES.map((f) => [f, read(dir, f)])) as Record<FileName, Json>;
const changes = JSON.parse(readFileSync(CHANGES_FILE, 'utf8')) as Change[];
const questionsOf = (bank: Json): Json[] => Object.values(bank.stages as Record<string, Json>).flatMap((s) => s.modules.flatMap((m: Json) => m.questions));
const stageQuestions = (bank: Json, stage: Stage): Json[] => (bank.stages[stage].modules as Json[]).flatMap((m) => m.questions);
const points = (s: string): number => [...s].length;

function holder(bundle: Record<FileName, Json>, c: Change): Json {
  if (c.file === 'questionBank.json') return questionsOf(bundle[c.file]).find((q) => q.id === c.id);
  if (c.file === 'reasonCodes.json') return bundle[c.file].codes.find((r: Json) => r.code === c.id);
  if (c.file === 'documentHelp.json') return bundle[c.file];
  if (c.file === 'assessmentAreas.json') return c.id === 'meta' ? bundle[c.file].meta : bundle[c.file].areas.find((a: Json) => a.id === c.id);
  return bundle[c.file];
}
/** `a.b[0].c` as the steps ["a", "b", 0, "c"]. */
const steps = (field: string): Array<string | number> => [...field.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] !== undefined ? Number(m[2]) : m[1]));
function get(o: Json, field: string): unknown { return steps(field).reduce((x, k) => x?.[k], o); }
function put(o: Json, field: string, v: unknown): void {
  const s = steps(field);
  const last = s.pop() as string | number;
  const parent = s.reduce((x, k, i) => (x[k] ??= typeof (s[i + 1] ?? last) === 'number' ? [] : {}), o);
  if (v === null) delete parent[last];
  else parent[last] = v;
}
const valueOf = (c: Change): unknown => (c.decision === 'decline' ? c.from : c.final);
/** A document-help row's value lives under the document type key. */
const current = (c: Change, h: Json): unknown => (c.file === 'documentHelp.json' ? h?.[c.id] : get(h, c.field));

/** 5.1.0 with the rows applied and meta.version 5.2.0. */
function expected(): Record<FileName, Json> {
  const b = readBundle(OLD);
  for (const c of changes) {
    const h = holder(b, c);
    expect(h, `${c.row} ${c.id}: nothing at that place`).toBeDefined();
    if (c.file === 'documentHelp.json') h[c.id] = valueOf(c);
    else put(h, c.field, valueOf(c));
  }
  b['questionBank.json'].meta.version = '5.2.0';
  b['assessmentAreas.json'].meta.version = '5.2.0';
  return b;
}

/** The document types a question's reason text feeds, from the field maps (a `record` source with the part `reason`). */
function fieldFeeding(): Map<string, Set<string>> {
  const feeds = new Map<string, Set<string>>();
  for (const doc of ['data_card', 'model_card', 'mitigation_plan']) {
    const map = JSON.parse(readFileSync(`data/fieldmaps/${doc}.json`, 'utf8')) as { fields: Array<{ sources: Json[] }> };
    for (const f of map.fields) for (const s of f.sources) {
      if (s.kind === 'record' && s.parts.includes('reason')) feeds.set(s.questionId, (feeds.get(s.questionId) ?? new Set()).add(doc));
    }
  }
  return feeds;
}
const DOC_NAME: Record<string, string> = { data_card: 'data card', model_card: 'model card', mitigation_plan: 'mitigation plan' };

const median = (v: number[]): number => {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length === 0 ? 0 : s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

describe('content 5.2.0, the draft for the owner', () => {
  it('5.2.0 equals 5.1.0 plus changes.json: every difference is a row, and every row is a difference', () => {
    const want = expected();
    for (const f of FILES) expect(read(NEW, f), f).toEqual(want[f]);
    const old = readBundle(OLD);
    const keys = changes.map((c) => `${c.file}|${c.id}|${c.field}`);
    expect(keys.filter((k, i) => keys.indexOf(k) !== i), 'rows name one place each').toEqual([]);
    for (const c of changes) {
      expect(['pending', 'accept', 'edit', 'decline'], c.row).toContain(c.decision);
      expect(current(c, holder(old, c)) ?? null, `${c.row} ${c.id} ${c.field}: from is the 5.1.0 value`).toEqual(c.from);
      if (c.decision !== 'decline') expect(valueOf(c), `${c.row}: a row that changes nothing`).not.toEqual(c.from);
    }
  });

  it('5.2.0 changes no gaps, optionGapMap, options, area or control', () => {
    const was = questionsOf(read(OLD, 'questionBank.json'));
    const now = questionsOf(read(NEW, 'questionBank.json'));
    expect(now.map((q) => q.id)).toEqual(was.map((q) => q.id));
    now.forEach((q, i) => {
      for (const k of ['gaps', 'optionGapMap', 'options', 'type', 'principle', 'conditionOn']) expect(q[k], `${q.id} ${k}`).toEqual(was[i][k]);
    });
    const areas = (dir: string) => { const a = read(dir, 'assessmentAreas.json'); return { ...a, meta: { ...a.meta, version: undefined } }; };
    expect(areas(NEW)).toEqual(areas(OLD));
  });

  it('5.2.0 passes the content check with completeness through an approved copy of its proposal, apart from sign-off problems', () => {
    // The validator reads a proposal only when its status is 'approved'; a draft's says 'checked' (draft-proposal.ts).
    const problems = withApprovedCopy(PROPOSAL_FILE, (file) => validateContentVersion(NEW, { baselineDir: 'data', proposalFile: file, completeness: true }));
    expect(problems.filter((p) => !/sign-off/.test(p))).toEqual([]);
  });

  it('index.json lists 5.2.0 and still runs 5.1.0', () => {
    const index = JSON.parse(readFileSync('data/content/index.json', 'utf8')) as { running: string; versions: string[] };
    expect(index.running).toBe('5.1.0');
    expect(index.versions).toEqual(['5.0.0', '5.1.0', '5.2.0']);
  });

  describe.each([...DRAFTED_STAGES])('the %s stage', (stage) => {
    const bank = read(NEW, 'questionBank.json');
    const qs = stageQuestions(bank, stage);
    const nonGate = qs.filter((q) => q.id !== GATE);

    it('every question has four different answer labels of 1 to 40 characters and four answer prompts of 1 to 200 characters in at most 2 sentences, and no reason prompt; the gate keeps its reason prompt and has neither', () => {
      for (const q of nonGate) {
        expect(Object.keys(q.answerLabels ?? {}).sort(), `${q.id} answerLabels`).toEqual([...KEYS].sort());
        expect(Object.keys(q.answerPrompts ?? {}).sort(), `${q.id} answerPrompts`).toEqual([...KEYS].sort());
        const labels = KEYS.map((k) => q.answerLabels[k] as string);
        expect(new Set(labels).size, `${q.id} labels are pairwise different`).toBe(4);
        for (const l of labels) { expect(points(l), `${q.id} label ${l}`).toBeGreaterThanOrEqual(1); expect(points(l), `${q.id} label ${l}`).toBeLessThanOrEqual(40); }
        for (const k of KEYS) {
          const p = q.answerPrompts[k] as string;
          expect(points(p), `${q.id} ${k} prompt`).toBeGreaterThanOrEqual(1);
          expect(points(p), `${q.id} ${k} prompt`).toBeLessThanOrEqual(200);
          expect(sentenceCount(p), `${q.id} ${k} prompt`).toBeLessThanOrEqual(2);
        }
        expect(q.reasonPrompt, `${q.id} has no reasonPrompt`).toBeUndefined();
      }
      for (const q of qs.filter((x) => x.id === GATE)) {
        expect(q.reasonPrompt, 'the gate keeps its reasonPrompt').toBeTypeOf('string');
        expect(q.answerLabels, 'the gate has no answerLabels').toBeUndefined();
        expect(q.answerPrompts, 'the gate has no answerPrompts').toBeUndefined();
      }
    });

    it('every question, the gate included, has practiceSameAs equal to ["5.0.0","5.1.0"] or ["5.1.0"] or []', () => {
      const older = new Map(questionsOf(read(OLDER, 'questionBank.json')).map((q) => [q.id, q]));
      const prev = new Map(questionsOf(read(OLD, 'questionBank.json')).map((q) => [q.id, q]));
      for (const q of qs) {
        expect([['5.0.0', '5.1.0'], ['5.1.0'], []], q.id).toContainEqual(q.practiceSameAs);
        // 5.0.0 is listed only where 5.1.0's expectedPractice is 5.0.0's (the practice 5.1.0 itself did not change).
        if ((q.practiceSameAs as string[]).includes('5.0.0')) expect(prev.get(q.id)?.expectedPractice, `${q.id} 5.0.0`).toBe(older.get(q.id)?.expectedPractice);
      }
    });

    it("the stage's field-feeding questions' prompts each name the document they print in", () => {
      const feeds = fieldFeeding();
      for (const q of nonGate.filter((x) => feeds.has(x.id))) {
        for (const doc of feeds.get(q.id) as Set<string>) for (const k of KEYS) {
          expect((q.answerPrompts[k] as string).toLowerCase(), `${q.id} ${k} prompt names the ${DOC_NAME[doc]}`).toContain(DOC_NAME[doc]);
        }
      }
    });

    it("the median question words of the stage is at most 0.8 times the stage's 5.1.0 median (owner ruling R19)", () => {
      const of = (dir: string) => [...(loadContentFrom(dir) as { questions: Map<string, Json> }).questions.values()].filter((q) => q.stage === stage).map((q) => questionWords(q) as number);
      expect(median(of(NEW))).toBeLessThanOrEqual(0.8 * median(of(OLD)));
    });
  });

  const all = STAGES.every((s) => DRAFTED_STAGES.includes(s));
  it.runIf(all)('the 25 field-feeding questions are exactly the ones the field maps name, and the median question words of 5.2.0 is at most 96 (owner ruling R19)', () => {
    expect(fieldFeeding().size).toBe(25);
    const c = loadContentFrom(NEW) as { questions: Map<string, Json> };
    expect(median([...c.questions.values()].map((q) => questionWords(q) as number))).toBeLessThanOrEqual(96);
  });
  it.runIf(all)('every non-gate question of 5.2.0 has answerLabels and answerPrompts', () => {
    const qs = questionsOf(read(NEW, 'questionBank.json'));
    expect(qs.filter((q) => q.id !== GATE && (q.answerLabels === undefined || q.answerPrompts === undefined)).map((q) => q.id)).toEqual([]);
  });
});
