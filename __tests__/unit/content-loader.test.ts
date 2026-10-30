import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTENT_BUNDLE_FILES, computeVersionBundleHash, hashBundleFiles } from '@/lib/content/bundleHash';
import { buildLoadedContent, loadContent, questionApplies, questionsInStage, reasonCodesFor, runningContent } from '@/lib/content/loader';
import { AppError } from '@/lib/http/errors';
import * as root from '@/lib/content/root';
import { contentRoot } from '@/lib/content/root';
import { FIXTURE_QUESTION_IDS } from '../helpers/content';

/**
 * The one loader of a content version (FR-CNT-01 to 04, 06, 07). Every case runs on H0's fixture bundle
 * through the mocked `@/lib/content/root` (`__tests__/setup/content.ts`), never on the live 5.0.0 files.
 */

afterEach(() => vi.restoreAllMocks());

describe('loader', () => {
  it('FR-CNT-01: the running fixture loads with its hash, 78 ids and stage order', () => {
    const c = runningContent();
    expect(c.semver).toBe('0.0.1-fixture');
    expect(c.contentHash).toBe(computeVersionBundleHash(join(contentRoot(), '0.0.1-fixture')));
    expect([...c.questions.keys()].sort()).toEqual([...FIXTURE_QUESTION_IDS].sort());
    const pp = questionsInStage(c, 'pre-processing');
    expect(pp.map((q) => q.order)).toEqual(pp.map((_, i) => i));
    expect(pp[0]).toMatchObject({ id: 'Q-PP-01', stage: 'pre-processing', moduleId: 'pre-problem' });
  });

  it('FR-CNT-01: order restarts at 0 in each stage and follows module order, then file order', () => {
    const c = runningContent();
    const bank = JSON.parse(readFileSync(join(contentRoot(), '0.0.1-fixture', 'questionBank.json'), 'utf8')) as {
      stages: Record<string, { modules: Array<{ id: string; title: string; questions: Array<{ id: string }> }> }>;
    };
    for (const [stage, s] of Object.entries(bank.stages)) {
      const expected = s.modules.flatMap((m) => m.questions.map((q) => ({ id: q.id, moduleId: m.id, moduleTitle: m.title })));
      const got = questionsInStage(c, stage as 'pre-processing');
      expect(got.map(({ id, moduleId, moduleTitle }) => ({ id, moduleId, moduleTitle }))).toEqual(expected);
      expect(got.map((q) => q.order)).toEqual(got.map((_, i) => i));
      expect(got.every((q) => q.stage === stage)).toBe(true);
    }
    // The map itself is in the same stage-then-module-then-file order.
    expect([...c.questions.keys()]).toEqual([...FIXTURE_QUESTION_IDS]);
  });

  it('FR-CNT-07: two versions load side by side with their own wording', () => {
    const a = loadContent('0.0.1-fixture'), b = loadContent('0.0.2-fixture');
    expect(a.questions.get('Q-PP-01')!.expectedPractice).not.toBe(b.questions.get('Q-PP-01')!.expectedPractice);
    expect(a.questions.get('Q-PP-02')!.expectedPractice).toBe(b.questions.get('Q-PP-02')!.expectedPractice);
    expect(a.contentHash).not.toBe(b.contentHash);
    expect(loadContent('0.0.1-fixture')).toBe(a);   // cached per version directory
  });

  it('FR-CNT-07 NFR-SEC-11: loadContent refuses a semver outside index.json, including path segments', () => {
    for (const s of ['9.9.9', '../0.0.1-fixture', '0.0.1-fixture/../../..', '', '5.0.0\u0000'])
      expect(() => loadContent(s)).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
  });

  it('FR-CNT-07 NFR-SEC-11: a refused semver reaches no file, and a listed name that is not a semver is refused too', () => {
    const bytes = vi.spyOn(root, 'readContentBytes');
    for (const s of ['9.9.9', '../0.0.1-fixture', '5.0.0/../../.env', '', '5.0.0\u0000', '0.0.1-fixture\n'])
      expect(() => loadContent(s), JSON.stringify(s)).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
    // A value that is not a string at all (a database column read as something else) is refused the same way.
    for (const s of [undefined, null, 5, ['0.0.1-fixture'], { toString: () => '0.0.1-fixture' }])
      expect(() => loadContent(s as unknown as string)).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
    // Even when index.json itself lists a path-like name, the semver pattern stops it before a path is joined.
    vi.spyOn(root, 'readContentIndex').mockReturnValue({ running: '0.0.1-fixture', versions: ['../0.0.1-fixture', '5.0.0/../../.env', '0.0.1-fixture'] });
    for (const s of ['../0.0.1-fixture', '5.0.0/../../.env'])
      expect(() => loadContent(s)).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
    expect(bytes).not.toHaveBeenCalled();
  });

  it('FR-DEC-02 (reach): runningContent reads index.json once per call, warm or cold', async () => {
    runningContent();   // warm the cache
    // The fixture mock's runningSemver does not touch the index; the real one does (lib/content/root.ts:91-92), so
    // the stand-in below reads it the same way and a second read per call shows up.
    vi.spyOn(root, 'runningSemver').mockImplementation(() => root.readContentIndex().running);
    const index = vi.spyOn(root, 'readContentIndex');
    runningContent(); runningContent();
    expect(index).toHaveBeenCalledTimes(2);   // one per call, not two
    vi.restoreAllMocks();

    // A fresh module has an empty cache: its first call builds the content and still reads the index once.
    let reads = 0;
    const counted = (): ReturnType<typeof root.readContentIndex> => { reads++; return root.readContentIndex(); };
    vi.doMock('@/lib/content/root', () => ({ ...root, readContentIndex: counted, runningSemver: () => counted().running }));
    try {
      vi.resetModules();
      const fresh = await import('@/lib/content/loader');
      expect(fresh.runningContent().semver).toBe(root.runningSemver());
      expect(reads).toBe(1);
      fresh.runningContent();
      expect(reads).toBe(2);
    } finally {
      vi.doMock('@/lib/content/root', () => ({ ...root }));   // put the shared fixture mock back
      vi.resetModules();
    }
  });

  it('FR-CNT-07 NFR-SEC-11: runningContent refuses a running name that index.json does not list, and a versions that is not a list', () => {
    vi.spyOn(root, 'readContentIndex').mockReturnValue({ running: '9.9.9', versions: ['0.0.1-fixture'] });
    expect(() => runningContent()).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
    vi.spyOn(root, 'readContentIndex').mockReturnValue({ running: '0.0.1-fixture', versions: '0.0.1-fixture-rc1' as unknown as string[] });
    expect(() => runningContent()).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
    vi.spyOn(root, 'readContentIndex').mockReturnValue({ running: undefined as unknown as string, versions: ['0.0.1-fixture'] });
    expect(() => runningContent()).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
  });

  it('FR-CNT-04: Q-PP-13 and Q-PP-14 apply unless the scope answer is no; unconditioned questions always apply', () => {
    const c = runningContent();
    for (const id of ['Q-PP-13', 'Q-PP-14']) {
      expect(questionApplies(c, id, 'no')).toBe(false);
      for (const g of ['yes', 'not_sure', null] as const) expect(questionApplies(c, id, g)).toBe(true);
    }
    for (const g of ['yes', 'no', 'not_sure', null] as const) expect(questionApplies(c, 'Q-PP-01', g)).toBe(true);
    expect(questionApplies(c, 'Q-NOT-THERE', null)).toBe(false);
    // An answer a caller could not read (unset, or text that is not a scope answer) leaves the question showing.
    for (const g of [undefined, '', 'Yes', 'maybe'])
      expect(questionApplies(c, 'Q-PP-13', g as unknown as 'yes'), String(g)).toBe(true);
  });

  it('FR-CNT-06: no fixture question is hidden by an unlock rule', () => {
    const c = runningContent();
    expect([...c.questions.values()].filter((q) => !questionApplies(c, q.id, 'yes'))).toEqual([]);
  });

  it('FR-DEC-01 (helper): reason codes by status, in file order', () => {
    const c = runningContent();
    expect(reasonCodesFor(c, 'not_applicable').map((r) => r.code)[0]).toBe('na_no_personal_data');
    expect(reasonCodesFor(c, 'not_yet').every((r) => r.code.startsWith('ny_'))).toBe(true);
    expect(reasonCodesFor(c, 'not_applicable').length + reasonCodesFor(c, 'not_yet').length).toBe(14);
    expect(reasonCodesFor(c, 'not_applicable').every((r) => r.status === 'not_applicable')).toBe(true);
    expect([...reasonCodesFor(c, 'not_applicable'), ...reasonCodesFor(c, 'not_yet')].map((r) => r.code).sort()).toEqual(c.reasonCodes.map((r) => r.code).sort());
  });

  it('FR-CNT-06: questionsInStage throws a plain error naming a stage the content does not have, not an empty list', () => {
    const c = runningContent();
    for (const stage of ['pre_processing', 'Pre-Processing', '', undefined, 5]) {
      let caught: unknown;
      try { questionsInStage(c, stage as never); } catch (e) { caught = e; }
      expect(caught, String(stage)).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(AppError);   // a programming error: toResponse re-throws it, the client sees a bare 500
      expect((caught as Error).message).toBe(`questionsInStage: unknown stage ${JSON.stringify(String(stage))}`);
    }
    expect(questionsInStage(c, 'post-processing').length).toBeGreaterThan(0);
  });

  it('FR-DEC-01: reasonCodesFor throws a plain error naming a status the content does not have, not an empty list', () => {
    const c = runningContent();
    for (const status of ['not-applicable', 'NOT_YET', 'withdrawn', '', undefined, null]) {
      let caught: unknown;
      try { reasonCodesFor(c, status as never); } catch (e) { caught = e; }
      expect(caught, String(status)).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(AppError);
      expect((caught as Error).message).toBe(`reasonCodesFor: unknown status ${JSON.stringify(String(status))}`);
    }
    expect(reasonCodesFor(c, 'not_yet').length).toBeGreaterThan(0);
  });

  it('FR-CNT-01: buildLoadedContent hashes and parses exactly the five bundle files it is given', () => {
    const asked: string[] = [];
    const dir = join(contentRoot(), '0.0.1-fixture');
    const read = (f: (typeof CONTENT_BUNDLE_FILES)[number]): Uint8Array => { asked.push(f); return readFileSync(join(dir, f)); };
    const c = buildLoadedContent('0.0.1-fixture', read);
    expect(c.contentHash).toBe(hashBundleFiles((f) => readFileSync(join(dir, f))));
    // signoffs.json is outside the hash (contract "Content bundle"), so the loader never asks for it; each file is
    // read once, so the hash describes the bytes that were parsed.
    expect([...asked].sort()).toEqual([...CONTENT_BUNDLE_FILES].sort());
    expect(c.areas.size).toBeGreaterThan(0);
    expect(c.controls.size).toBeGreaterThan(0);
    expect(Object.keys(c.documentHelp).sort()).toEqual(['data_card', 'mitigation_plan', 'model_card']);
  });

  it('FR-CNT-01 NFR-SEC-11: CNT\'s runtime modules read content only through lib/content/root', () => {
    const src = readFileSync('lib/content/loader.ts', 'utf8');
    expect(src).toMatch(/import \{[^}]*\breadContentBytes\b[^}]*\} from '@\/lib\/content\/root'/);
    expect(src).toMatch(/hashBundleFiles\(/);
    for (const f of ['lib/content/loader.ts', 'lib/content/resources.ts', 'lib/content/signoffs.ts', 'lib/content/registryMigration.ts', 'lib/content/semver.ts', 'lib/data/framework.ts',
      'components/question/QuestionContent.tsx', 'app/(authenticated)/explore/framework/page.tsx'].filter(existsSync)) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/computeVersionBundleHash|contentRoot\(|['"]data\/content/);
    }
  });

  it('FR-CNT-01 NFR-SEC-11: the loader imports no file-system or path module', () => {
    const src = readFileSync('lib/content/loader.ts', 'utf8');
    expect(src).not.toMatch(/from ['"](node:)?(fs|path)(\/promises)?['"]/);
  });

  it('FR-CNT-04 FR-DEC-01: the loader derives its allowed values from the contract types, so a type change breaks the build', () => {
    const src = readFileSync('lib/content/loader.ts', 'utf8');
    // `satisfies` ties each list to its union: a value the type lacks, or a rename of the type, fails `npm run typecheck`.
    expect(src).toMatch(/REASON_STATUSES = \[[^\]]*\] as const satisfies readonly ReasonCodeEntry\['status'\]\[\]/);
    expect(src).toMatch(/CONDITION_VALUE = 'yes' as const satisfies ScopeAnswer/);
    expect(src).not.toMatch(/(REASON_STATUSES|SCOPE_ANSWERS): readonly string\[\]/);
  });

  it('FR-CNT-07 NFR-SEC-11: the semver pattern lives in lib/content/semver.ts, which the loader and the migration renderer both import', async () => {
    const { SEMVER_RE } = await import('@/lib/content/semver');
    for (const ok of ['5.0.0', '0.0.1-fixture', '10.20.30-rc.1']) expect(SEMVER_RE.test(ok), ok).toBe(true);
    for (const bad of ['', '5.0', '../5.0.0', "5.0.0'; --", '5.0.0\n', '5.0.0/x']) expect(SEMVER_RE.test(bad), JSON.stringify(bad)).toBe(false);
    // The runtime loader does not carry the module that turns values into owner-role SQL.
    expect(readFileSync('lib/content/loader.ts', 'utf8')).toMatch(/from '@\/lib\/content\/semver'/);
    expect(readFileSync('lib/content/loader.ts', 'utf8')).not.toMatch(/registryMigration/);
    expect(readFileSync('lib/content/registryMigration.ts', 'utf8')).toMatch(/from '@\/lib\/content\/semver'/);
  });
});

describe('buildLoadedContent refuses a version it cannot read whole', () => {
  type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any -- the cases below edit JSON of any shape
  const dir = () => join(contentRoot(), '0.0.1-fixture');
  const fixture = (f: string): Buffer => readFileSync(join(dir(), f));
  const json = (f: string): Any => JSON.parse(fixture(f).toString('utf8'));
  /** The fixture version with one file replaced: `edit` gets the parsed file and returns the new value or raw bytes. */
  const build = (file: (typeof CONTENT_BUNDLE_FILES)[number], edit: (v: Any) => unknown) =>
    () => buildLoadedContent('0.0.1-fixture', (f) => {
      if (f !== file) return fixture(f);
      const out = edit(json(f));
      return out instanceof Uint8Array ? out : Buffer.from(JSON.stringify(out));
    });
  const questionsOf = (bank: Any): Any[] => Object.values<Any>(bank.stages).flatMap((s) => s.modules).flatMap((m: Any) => m.questions);
  const refuses = (fn: () => unknown, message: RegExp) => expect(fn).toThrow(message);

  it('FR-CNT-01 NFR-SEC-11: a file that is not UTF-8 JSON throws a plain error naming the version and the file', () => {
    let caught: unknown;
    try { build('questionBank.json', () => Buffer.from('{"stages":'))(); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('content 0.0.1-fixture: questionBank.json is not valid UTF-8 JSON');
    expect((caught as Error).cause).toBeInstanceOf(Error);
    // Not an AppError: toResponse re-throws it, so no path or value reaches a client.
    expect(caught).not.toBeInstanceOf(AppError);
    // A byte that is not UTF-8 is not turned into U+FFFD and served.
    refuses(build('documentHelp.json', () => Buffer.from(fixture('documentHelp.json').toString('utf8').replace('data', 'd\u00e9ta'), 'latin1')), /documentHelp\.json is not valid UTF-8 JSON/);
  });

  it('FR-CNT-01: a file of the wrong shape throws instead of loading empty', () => {
    refuses(build('reasonCodes.json', () => ({})), /reasonCodes\.json codes is not a list/);
    refuses(build('reasonCodes.json', () => []), /reasonCodes\.json is not an object/);
    refuses(build('documentHelp.json', () => null), /documentHelp\.json is not an object/);
    refuses(build('documentHelp.json', (v) => ({ ...v, data_card: 5 })), /documentHelp\.json data_card is not text/);
    refuses(build('assessmentAreas.json', (v) => ({ ...v, areas: 'none' })), /assessmentAreas\.json areas is not a list/);
    refuses(build('questionBank.json', () => ({ meta: {} })), /questionBank\.json stages is not an object/);
  });

  it('FR-CNT-01 FR-CNT-02: a module without a title throws, so a question never carries moduleTitle undefined', () => {
    const modules = (v: Any): Any[] => Object.values<Any>(v.stages).flatMap((st) => st.modules);
    refuses(build('questionBank.json', (v) => { delete modules(v)[0].title; return v; }), /module pre-problem has no title/);
    refuses(build('questionBank.json', (v) => { modules(v)[2].title = 7; return v; }), /module in-model-dev has no title/);
  });

  it('FR-CNT-01 FR-CNT-02: a question without text, or with a type the contract does not allow, throws', () => {
    refuses(build('questionBank.json', (v) => { delete questionsOf(v)[0].text; return v; }), /question Q-PP-01 has no text/);
    refuses(build('questionBank.json', (v) => { questionsOf(v)[1].text = null; return v; }), /question Q-PP-02 has no text/);
    for (const type of ['likert', 'Gate', 'radio', '', undefined, 5])
      refuses(build('questionBank.json', (v) => { questionsOf(v)[0].type = type; return v; }), /question Q-PP-01 has an unknown type/);
    // The three types the contract names still load (the fixture holds all of them).
    const types = new Set([...build('questionBank.json', (v) => v)().questions.values()].map((q) => q.type));
    expect([...types].sort()).toEqual(['checklist', 'gate', 'likert-5']);
  });

  it('FR-CNT-01 FR-CNT-02: a documentHelp.json without one of the three document types, or with another key, throws', () => {
    for (const type of ['data_card', 'model_card', 'mitigation_plan'])
      refuses(build('documentHelp.json', (v) => { delete v[type]; return v; }), new RegExp(`documentHelp\\.json has no ${type}`));
    refuses(build('documentHelp.json', () => ({})), /documentHelp\.json has no data_card/);
    refuses(build('documentHelp.json', (v) => ({ ...v, risk_card: 'extra' })), /documentHelp\.json has an unknown key risk_card/);
  });

  it('FR-CNT-01 FR-CNT-06: a stage that is missing or extra throws, and a stage without a module list throws', () => {
    refuses(build('questionBank.json', (v) => { delete v.stages['in-processing']; return v; }), /has no stage in-processing/);
    refuses(build('questionBank.json', (v) => { v.stages.extra = { modules: [] }; return v; }), /unknown stage extra/);
    refuses(build('questionBank.json', (v) => { v.stages['post-processing'] = {}; return v; }), /stage post-processing modules is not a list/);
  });

  it('FR-CNT-01: a repeated or missing id throws (question, module, area, control, reason code)', () => {
    refuses(build('questionBank.json', (v) => { const q = questionsOf(v); q[1].id = q[0].id; return v; }), /question id Q-PP-01 appears twice/);
    refuses(build('questionBank.json', (v) => { delete questionsOf(v)[3].id; return v; }), /question has no id/);
    refuses(build('questionBank.json', (v) => { const m = Object.values<Any>(v.stages).flatMap((s) => s.modules); m[1].id = m[0].id; return v; }), /module id pre-problem appears twice/);
    refuses(build('assessmentAreas.json', (v) => { v.areas[1].id = v.areas[0].id; return v; }), /area id \S+ appears twice/);
    refuses(build('assessmentAreas.json', (v) => { v.controls[1].id = v.controls[0].id; return v; }), /control id \S+ appears twice/);
    refuses(build('reasonCodes.json', (v) => { v.codes[1].code = v.codes[0].code; return v; }), /reason code na_no_personal_data appears twice/);
    refuses(build('reasonCodes.json', (v) => { delete v.codes[0].code; return v; }), /a reason code has no code/);
  });

  it('FR-CNT-01 FR-DEC-01: a reason code with an unknown status throws, so it cannot fall out of both lists', () => {
    refuses(build('reasonCodes.json', (v) => { v.codes[0].status = 'not-applicable'; return v; }), /reason code na_no_personal_data has an unknown status/);
  });

  it('FR-CNT-04: a condition whose value is not "yes" throws, so a consent question cannot be hidden or inverted by a typo', () => {
    const conditioned = (v: Any): Any => questionsOf(v).find((q) => q.id === 'Q-PP-13');
    // The contract fixes the value at "yes" (loader row); "no" would invert questionApplies, "Yes" would hide the question.
    for (const value of ['Yes', 'no', 'not_sure', '', 'maybe', true, null])
      refuses(build('questionBank.json', (v) => { conditioned(v).condition.value = value; return v; }), /question Q-PP-13 has a condition whose value is not "yes"/);
    refuses(build('questionBank.json', (v) => { conditioned(v).condition = { questionId: 'Q-PP-GATE-SENSITIVE' }; return v; }), /condition whose value is not "yes"/);
  });

  it('FR-CNT-04: a condition must name a question of type gate in the same bundle, whatever that gate is called', () => {
    const conditioned = (v: Any): Any => questionsOf(v).find((q) => q.id === 'Q-PP-13');
    refuses(build('questionBank.json', (v) => { conditioned(v).condition = { questionId: 'Q-PP-01', value: 'yes' }; return v; }), /question Q-PP-13 has a condition on Q-PP-01, which is not a gate question/);
    refuses(build('questionBank.json', (v) => { conditioned(v).condition = { questionId: 'Q-NO-SUCH-GATE', value: 'yes' }; return v; }), /Q-NO-SUCH-GATE, which is not a gate question/);
    // A gate with another name loads when every condition follows it: the loader does not hard-code the fixture's gate.
    const renamed = build('questionBank.json', (v) => {
      for (const q of questionsOf(v)) {
        if (q.id === 'Q-PP-GATE-SENSITIVE') q.id = 'Q-XX-OWN-GATE';
        if (q.condition) q.condition.questionId = 'Q-XX-OWN-GATE';
      }
      return v;
    })();
    expect(renamed.questions.get('Q-PP-13')!.condition).toEqual({ questionId: 'Q-XX-OWN-GATE', value: 'yes' });
    // The real condition still loads.
    expect(build('questionBank.json', (v) => v)().questions.get('Q-PP-13')!.condition).toEqual({ questionId: 'Q-PP-GATE-SENSITIVE', value: 'yes' });
  });

  it('FR-CNT-01: the loaded content is frozen all the way down, because every request shares it', () => {
    const c = runningContent();
    const q = c.questions.get('Q-PP-13')!;
    expect(Object.isFrozen(c) && Object.isFrozen(q) && Object.isFrozen(q.condition) && Object.isFrozen(c.reasonCodes) && Object.isFrozen(c.reasonCodes[0]) && Object.isFrozen(c.documentHelp)).toBe(true);
    expect(() => { (q as { text: string }).text = 'changed'; }).toThrow(TypeError);
    expect(() => { (c.documentHelp as Record<string, string>).data_card = 'changed'; }).toThrow(TypeError);
    expect(loadContent('0.0.1-fixture').questions.get('Q-PP-13')!.text).not.toBe('changed');
    expect(Object.isFrozen(questionsInStage(c, 'pre-processing'))).toBe(false); // a fresh list the caller may sort
  });

  it('FR-CNT-07 NFR-SEC-11: an index.json whose versions is not a list is refused, not matched by substring', () => {
    vi.spyOn(root, 'readContentIndex').mockReturnValue({ running: '0.0.1-fixture', versions: '0.0.1-fixture-rc1' as unknown as string[] });
    expect(() => loadContent('0.0.1-fixture')).toThrow(expect.objectContaining({ status: 500, code: 'unknown_content_version' }));
  });
});
