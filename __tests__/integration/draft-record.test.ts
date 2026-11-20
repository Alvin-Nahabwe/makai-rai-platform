import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { OrgRole } from '@prisma/client';
import type { DocumentType, Stage } from '@/types/record';
import { STAGES } from '@/types/record';
import { NotFoundError, withOrg, type TenantTx } from '@/lib/data/tenant';
import { draftSnapshot, liveDecisionRows, readDocumentSnapshot, readDraftRecord, type DraftRecord } from '@/lib/data/documents';
import { loadFieldMap } from '@/lib/documents/fieldMaps';
import { resolveFields } from '@/lib/documents/resolve';
import { DRAFT_PROJECT_MARK, GATE_DERIVED_NA, NOT_RECORDED_YET, PROJECT_MARK, docTextErasedLine, draftReviewLine, findingOnQuestion } from '@/lib/documents/copy';
import type { LoadedQuestion } from '@/types/content';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { loadContent } from '@/lib/content/loader';
import { SEAL_SOURCE_TABLES, type SealSourceRows } from '@/lib/integrity/sealCheck.mjs';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addAcceptedRisk, addDecision, addFinding, addMitigationVersion, addProject, addStageReview, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { sealFixture } from '../helpers/sealFixture';
import { captureLogs } from '../helpers/logCapture';
import { rememberFixtureRow } from '../setup/content';

/**
 * Task 6 (path to outputs): the draft record is built from the rows a seal of each stage would name now, never from a seal, and the
 * one resolver prints it (ADR 0023). Anti-goals 2 and 5, Review Focus 1 to 5, conflicts 3, 16 and 23.
 */

const FIXTURE = join(process.cwd(), '__tests__', 'fixtures', 'content', '0.0.1-fixture');
const reasonCodes = (JSON.parse(readFileSync(join(FIXTURE, 'reasonCodes.json'), 'utf8')) as { codes: Array<{ code: string; status: string }> }).codes;
const NA = reasonCodes.filter((c) => c.status === 'not_applicable')[0].code;

let fx: OrgFixture;
let contentVersionId: string;
let projectId: string;

const ROLE: OrgRole = 'admin';
const ctx = () => ctxFor(fx, ROLE);
const viewer = () => ({ userId: fx.members[ROLE].userId, role: ROLE });
const readDraft = (pid = projectId, f = fx): Promise<DraftRecord> =>
  withOrg(ctxFor(f, ROLE), (tx) => readDraftRecord(tx, pid, { userId: f.members[ROLE].userId, role: ROLE }), { isolationLevel: 'RepeatableRead' });
const readSealed = (a: { reviewId: string; sealId: string; documentType: DocumentType }) =>
  withOrg(ctx(), (tx) => readDocumentSnapshot(tx, { projectId, ...a }), { isolationLevel: 'RepeatableRead' });

const decide = (stage: Stage, questionId: string, extra: Partial<Parameters<typeof addDecision>[2]> = {}) =>
  addDecision(fx, projectId, { stage, questionId, contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members.owner.userId }, declaredDate: '2026-10-30', ...extra });

/** The document types and review stages of the five drafts a project shows: the two cards on their stages, a plan per stage. */
const DRAFTS: Array<{ type: DocumentType; stage: Stage }> = [
  { type: 'data_card', stage: 'pre-processing' }, { type: 'model_card', stage: 'in-processing' },
  ...STAGES.map((stage) => ({ type: 'mitigation_plan' as const, stage })),
];
const ANSWER_KINDS = new Set(['record', 'record_option', 'findings', 'mitigations', 'accepted_risks', 'project']);
const ANSWER_META = new Set(['deciders', 'no_decision', 'not_applicable']);
/** The fields anti-goal 2 binds: every source filled from answers, project, findings, or answer-derived meta. */
const answerFields = (type: DocumentType): string[] => loadFieldMap(type).fields
  .filter((e) => e.sources.every((s) => ANSWER_KINDS.has(s.kind)) || e.sources.some((s) => s.kind === 'meta' && ANSWER_META.has(s.item)))
  .map((e) => e.fieldId);
/** The one deliberate difference on those fields: the line under a project value (anti-goal 1, ADR 0023). */
const asDraft = (t: string | null): string | null => (t === null ? null : t.split(PROJECT_MARK).join(DRAFT_PROJECT_MARK));
const textOf = (r: ReturnType<typeof resolveFields>, id: string) => r.fields.find((f) => f.fieldId === id);

beforeEach(async () => {
  await resetDb();
  ({ contentVersionId } = await useFixtureContent('0.0.1-fixture'));
  fx = await buildOrg({ label: 'draftrec' });
  projectId = (await addProject(fx)).id;
});

/** Answers in all three stages: a Not applicable, a Partly with a finding, a mitigation, an accepted risk, the gate answered No. Q-PP-16 (DC-09's question) is left unanswered. */
async function answerAll(): Promise<void> {
  await testDb.projectMetadata.create({ data: {
    orgId: fx.org.id, projectId, fundingSource: 'A national fund', datasetDescription: 'Field photographs', country: 'Uganda', processesPersonalData: true,
  } });
  await decide('pre-processing', 'Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'no' });
  await decide('pre-processing', 'Q-PP-12');
  await decide('pre-processing', 'Q-PP-08', { status: 'not_applicable', reasonCode: NA });
  const partly = await decide('pre-processing', 'Q-PP-09', { status: 'partly' });
  const shortfall = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-PP-09', decisionVersionId: partly.id });
  await addMitigationVersion(fx, shortfall.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
  const accepted = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-03' });
  await addAcceptedRisk(fx, accepted.id, { lookAgainOn: '2027-01-15' });
  await decide('in-processing', 'Q-IP-01');
  await decide('in-processing', 'Q-IP-02', { decidedBy: { kind: 'outside_role', role: 'ethics_committee' } });
  await decide('post-processing', 'Q-PO-01');
  await decide('post-processing', 'Q-PO-15');
}

/** A review per stage, each sealed once: the stage's seal id by stage. */
async function sealAll(): Promise<Record<Stage, { reviewId: string; sealId: string }>> {
  const out = {} as Record<Stage, { reviewId: string; sealId: string }>;
  for (const stage of STAGES) {
    const reviewId = (await addStageReview(fx, projectId, { stage })).id;
    out[stage] = { reviewId, sealId: (await sealFixture(fx, reviewId, { projectId })).id };
  }
  return out;
}

const counts = async () => ({
  issued: await testDb.issuedDocument.count(), seals: await testDb.seal.count(), reviews: await testDb.stageReview.count(),
  drafts: await testDb.documentDraftFields.count(),
});

describe('the draft record (Task 6)', () => {
  it('anti-goal 2: draft and sealed agree on every field filled from answers, project, findings or answer-derived meta', async () => {
    await answerAll();
    const sealed = await sealAll();
    const r = await readDraft();

    const compared = new Set<string>();
    const printed = new Set<string>();
    for (const { type, stage } of DRAFTS) {
      const map = loadFieldMap(type);
      const fromSeal = resolveFields(map, await readSealed({ ...sealed[stage], documentType: type }), {});
      const fromDraft = resolveFields(map, draftSnapshot(r, type, stage), {});
      for (const id of answerFields(type)) {
        compared.add(id);
        const s = textOf(fromSeal, id);
        const d = textOf(fromDraft, id);
        expect({ id, stage, text: d?.text, provenance: d?.provenance }).toEqual({ id, stage, text: asDraft(s?.text ?? null), provenance: s?.provenance });
        if (s?.text != null && !fromSeal.notRecordedFields.includes(id) && s.text !== 'None') printed.add(`${stage}:${id}`);
      }
    }
    expect(compared.size).toBe(39);
    expect([...compared]).toEqual(expect.arrayContaining(['DC-32', 'MC-30', 'MP-07', 'MP-08']));
    // Not a comparison of blanks: the decisions, the outside decider, the finding, mitigation and accepted risk, and project values printed.
    expect([...printed]).toEqual(expect.arrayContaining([
      'pre-processing:DC-32', 'in-processing:MC-30', 'pre-processing:DC-03', 'pre-processing:MP-02', 'pre-processing:MP-03', 'pre-processing:MP-06',
      'pre-processing:MP-07', 'pre-processing:MP-08', 'post-processing:MP-07',
    ]));
    // The project mark is the only rewrite: a project value was printed, and the draft prints the draft mark under it.
    expect(textOf(resolveFields(loadFieldMap('data_card'), draftSnapshot(r, 'data_card', 'pre-processing'), {}), 'DC-03')?.text).toBe(`A national fund\n${DRAFT_PROJECT_MARK}`);
  });

  it('gate-derived Not applicable: with the gate answered No, Q-PP-13 and Q-PP-14 print GATE_DERIVED_NA in the draft as in a seal taken at the same moment', async () => {
    await decide('pre-processing', 'Q-PP-GATE-SENSITIVE', { status: null, scopeAnswer: 'no' });
    const sealed = await sealAll();
    const r = await readDraft();
    const map = loadFieldMap('mitigation_plan');
    const draftNa = textOf(resolveFields(map, draftSnapshot(r, 'mitigation_plan', 'pre-processing'), {}), 'MP-08')?.text;
    const sealedNa = textOf(resolveFields(map, await readSealed({ ...sealed['pre-processing'], documentType: 'mitigation_plan' }), {}), 'MP-08')?.text;
    expect(draftNa).toContain(`Q-PP-13: ${GATE_DERIVED_NA}`);
    expect(draftNa).toContain(`Q-PP-14: ${GATE_DERIVED_NA}`);
    expect(draftNa).toBe(sealedNa);
    expect([...r.stages['pre-processing'].derived.keys()].sort()).toEqual(['Q-PP-13', 'Q-PP-14']);
  });

  it('anti-goal 5: building drafts writes nothing', async () => {
    await answerAll();
    await sealAll();
    await addStageReview(fx, projectId, { stage: 'pre-processing' });
    const before = await counts();
    const r = await readDraft();
    for (const { type, stage } of DRAFTS) resolveFields(loadFieldMap(type), draftSnapshot(r, type, stage), {});
    expect(await counts()).toEqual(before);
  });

  it('a draft never reads a seal: a sealed answer changed since prints the current one, and the build touches no seals or issued documents', async () => {
    await decide('pre-processing', 'Q-PP-12');
    await sealAll();
    const v2 = await decide('pre-processing', 'Q-PP-12', { status: 'partly' });
    const forbidden = /\b(seals|issued_documents|issued_document_seals)\b/;
    const guarded = (tx: TenantTx): TenantTx => new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === 'seal' || prop === 'issuedDocument' || prop === 'issuedDocumentSeal') throw new Error(`the draft builder read ${String(prop)}`);
        const v = Reflect.get(target, prop, receiver) as unknown;
        if (prop === '$queryRaw' || prop === '$queryRawUnsafe' || prop === '$executeRawUnsafe') {
          return (sql: string | TemplateStringsArray, ...rest: unknown[]) => {
            const text = typeof sql === 'string' ? sql : sql.join('?');
            if (forbidden.test(text)) throw new Error(`the draft builder queried ${text}`);
            return (v as (...a: unknown[]) => unknown).call(target, sql, ...rest);
          };
        }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const r = await withOrg(ctx(), (tx) => readDraftRecord(guarded(tx), projectId, viewer()), { isolationLevel: 'RepeatableRead' });
    const current = r.stages['pre-processing'].decisions.get('Q-PP-12');
    expect(current?.row.id).toBe(v2.id);
    expect(current?.row.status).toBe('partly');
    expect(r.stages['pre-processing'].seal.kind).toBe('draft');
  });

  it('Review Focus 3: the draft record of an archived project builds', async () => {
    await decide('pre-processing', 'Q-PP-12');
    await testDb.project.update({ where: { id: projectId }, data: { archivedAt: new Date() } });
    const r = await readDraft();
    expect(r.stagesWithAnswers).toEqual(['pre-processing']);
    expect(r.stages['pre-processing'].decisions.has('Q-PP-12')).toBe(true);
  });

  it('Review Focus 2: an erased finding title prints the erasure line in the draft', async () => {
    const f = await addFinding(fx, projectId, { stage: 'pre-processing', source: 'team', riskArea: 'PP-02' });
    await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    const title = (await testDb.finding.findUniqueOrThrow({ where: { id: f.id }, select: { title: true } })).title as string;
    await testDb.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL ROLE makrai_operator_fn');
      await tx.$executeRawUnsafe(`SELECT erase_text_field('${fx.org.id}','findings','${f.id}','title','ER-1','INSTR-1')`);
    });
    const [{ on }] = await testDb.$queryRaw<{ on: string }[]>`SELECT to_char(min("at") AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS on FROM tombstones WHERE "targetId" = ${f.id}`;
    const r = await readDraft();
    const text = resolveFields(loadFieldMap('mitigation_plan'), draftSnapshot(r, 'mitigation_plan', 'pre-processing'), {}).fields.map((x) => x.text ?? '').join('\n');
    expect(text).toContain(docTextErasedLine(on));
    expect(text).not.toContain(title);
  });

  it('Review Focus 5: no answers gives stagesWithAnswers [] and three empty stages, and the draft data card reads Not recorded yet in its record fields', async () => {
    const r = await readDraft();
    expect(r.stagesWithAnswers).toEqual([]);
    expect(r.omittedAnswers).toBe(0);
    for (const stage of STAGES) {
      const s = r.stages[stage];
      expect([s.decisions.size, s.derived.size, s.findings.length]).toEqual([0, 0, 0]);
      expect(s.seal).toMatchObject({ kind: 'draft', key: `draft:${stage}`, openReview: null, lastSealedReview: null, enteredByPeople: 0 });
    }
    const map = loadFieldMap('data_card');
    const dc = resolveFields(map, draftSnapshot(r, 'data_card', 'pre-processing'), {});
    const recordOnly = map.fields.filter((e) => e.sources.every((s) => s.kind === 'record' || s.kind === 'record_option')).map((e) => e.fieldId);
    expect(recordOnly.length).toBeGreaterThan(0);
    for (const id of recordOnly) expect({ id, text: textOf(dc, id)?.text }).toEqual({ id, text: NOT_RECORDED_YET });
    // MP-07 lists the stage's unanswered questions from the manifest's `none` entries, never a bare "None".
    for (const stage of STAGES) {
      const mp07 = textOf(resolveFields(loadFieldMap('mitigation_plan'), draftSnapshot(r, 'mitigation_plan', stage), {}), 'MP-07')?.text ?? '';
      expect(mp07).not.toBe('None');
      expect(mp07.split('\n').length).toBe(r.stages[stage].manifest.decisions.length);
    }
  });

  it('conflict 16: MP-01 names the newest unsealed review as open and the newest sealed one as the last sealed, or neither', async () => {
    await decide('pre-processing', 'Q-PP-12');
    await decide('in-processing', 'Q-IP-01');
    const pp1 = (await addStageReview(fx, projectId, { stage: 'pre-processing' })).id;
    await sealFixture(fx, pp1, { projectId });
    await addStageReview(fx, projectId, { stage: 'pre-processing' });
    const ip1 = (await addStageReview(fx, projectId, { stage: 'in-processing' })).id;
    await sealFixture(fx, ip1, { projectId });
    const r = await readDraft();
    expect(r.stages['pre-processing'].seal).toMatchObject({ openReview: { reviewName: 'Pre-processing review 2' }, lastSealedReview: { reviewId: pp1, reviewName: 'Pre-processing review 1' } });
    expect(r.stages['in-processing'].seal).toMatchObject({ openReview: null, lastSealedReview: { reviewId: ip1, reviewName: 'In-processing review 1' } });
    expect(r.stages['post-processing'].seal).toMatchObject({ openReview: null, lastSealedReview: null });
    const mp01 = textOf(resolveFields(loadFieldMap('mitigation_plan'), draftSnapshot(r, 'mitigation_plan', 'post-processing'), {}), 'MP-01')?.text;
    expect(mp01).toBe(draftReviewLine(FINDINGS_COPY.stages['post-processing'], null, null));
  });

  it('Review Focus 1: a current decision on a question the running content lacks is left out, logged once by id, and the record still builds', async () => {
    await decide('pre-processing', 'Q-PP-12');
    const orphan = await decide('pre-processing', 'Q-ZZ-99');
    await addFinding(fx, projectId, { stage: 'pre-processing', source: 'shortfall', questionId: 'Q-ZZ-99', decisionVersionId: orphan.id });
    const { result: r, lines } = await captureLogs(() => readDraft());
    const logged = lines.filter((l) => l.includes('DRAFT_ORPHAN_DECISION'));
    expect(logged).toHaveLength(1);
    expect(JSON.parse(logged[0])).toMatchObject({ event: 'DRAFT_ORPHAN_DECISION', level: 'warn', details: { decisionVersionId: orphan.id, stage: 'pre-processing' } });
    expect(r.stages['pre-processing'].decisions.has('Q-ZZ-99')).toBe(false);
    expect(r.stages['pre-processing'].decisions.has('Q-PP-12')).toBe(true);
    expect(r.omittedAnswers).toBe(1);
    expect(draftSnapshot(r, 'data_card', 'pre-processing').provenance).toEqual({ kind: 'draft', takenAt: r.takenAt, omittedAnswers: 1, recordedQuestionWords: new Map() });
    // The finding on the orphan question is still the stage's, and every draft resolves.
    expect(r.stages['pre-processing'].findings).toHaveLength(1);
    for (const { type, stage } of DRAFTS) expect(() => resolveFields(loadFieldMap(type), draftSnapshot(r, type, stage), {})).not.toThrow();
  });

  /** A shortfall finding as the decision service raises it (`onShortfallSaved`, lib/data/findings.ts): no title, no description. */
  const raiseShortfall = (questionId: string, decisionVersionId: string) => testDb.finding.create({ data: {
    orgId: fx.org.id, projectId, stage: 'pre-processing', source: 'shortfall', questionId, decisionVersionId, riskArea: null, title: null,
    description: null, raisedById: fx.members.assessor.userId, requestId: randomUUID(), requestDigest: createHash('sha256').update(randomUUID()).digest('hex'),
  } });
  /** The draft mitigation plan of pre-processing's three finding fields, as printed. */
  const planFindingTexts = (r: DraftRecord): string[] => {
    const out = resolveFields(loadFieldMap('mitigation_plan'), draftSnapshot(r, 'mitigation_plan', 'pre-processing'), {});
    return out.fields.map((f) => f.text ?? '');
  };

  it('I1: a title-less shortfall finding on a question the running content removed prints that question in the wording of the version its decision was recorded against', async () => {
    // Recorded against 0.0.1-fixture; the running content becomes 0.0.2-fixture without Q-PP-01 (whose 0.0.2 wording differs).
    const recordedWords = loadContent('0.0.1-fixture').questions.get('Q-PP-01')?.text as string;
    const partly = await decide('pre-processing', 'Q-PP-01', { status: 'partly' });
    const finding = await raiseShortfall('Q-PP-01', partly.id);
    await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01' });
    await useFixtureContent('0.0.2-fixture');
    const running = loadContent('0.0.2-fixture').questions as Map<string, LoadedQuestion>;
    const removed = running.get('Q-PP-01') as LoadedQuestion;
    expect(removed.text).not.toBe(recordedWords);
    running.delete('Q-PP-01');
    try {
      const r = await readDraft();
      expect(r.stages['pre-processing'].findings.map((f) => f.finding.title)).toEqual([null]);
      const texts = planFindingTexts(r);
      expect(texts.some((t) => t.includes(findingOnQuestion(recordedWords, 'Q-PP-01')))).toBe(true);
      expect(texts.some((t) => t.includes(removed.text))).toBe(false);
      for (const { type, stage } of DRAFTS) expect(() => resolveFields(loadFieldMap(type), draftSnapshot(r, type, stage), {})).not.toThrow();
    } finally {
      running.set('Q-PP-01', removed);
    }
  });

  it('I1: when no content version holds the removed question either, the finding prints its id and the fixed line, and is not dropped', async () => {
    const orphan = await decide('pre-processing', 'Q-ZZ-99', { status: 'partly' });
    await raiseShortfall('Q-ZZ-99', orphan.id);
    const r = await readDraft();
    const texts = planFindingTexts(r);
    expect(texts.some((t) => t.includes('Q-ZZ-99 · question no longer in the framework'))).toBe(true);
    for (const { type, stage } of DRAFTS) expect(() => resolveFields(loadFieldMap(type), draftSnapshot(r, type, stage), {})).not.toThrow();
  });

  it('SF M1 (fix wave item 15): a removed question recorded against a version this deployment does not list prints the fixed line and logs DRAFT_CONTENT_VERSION_UNLISTED once', async () => {
    const id = randomUUID();
    rememberFixtureRow(id);
    await testDb.frameworkVersion.create({ data: { id, semver: '0.0.9-unlisted', contentHash: 'x'.repeat(64), publishedAt: new Date('2026-01-01T00:00:00Z'), status: 'deprecated' } });
    const orphan = await decide('pre-processing', 'Q-ZZ-99', { status: 'partly', contentVersionId: id });
    await raiseShortfall('Q-ZZ-99', orphan.id);
    const { result: r, lines } = await captureLogs(() => readDraft());
    expect(planFindingTexts(r).some((t) => t.includes('Q-ZZ-99 · question no longer in the framework'))).toBe(true);
    const logged = lines.filter((l) => l.includes('DRAFT_CONTENT_VERSION_UNLISTED')).map((l) => JSON.parse(l));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ level: 'warn', details: { contentVersionId: id } });
    // Once per id per process (final review M12's rule): a second read of the same record logs nothing new.
    const again = await captureLogs(() => readDraft());
    expect(again.lines.filter((l) => l.includes('DRAFT_CONTENT_VERSION_UNLISTED'))).toEqual([]);
  });

  it('final review M12 / SF M3 (fix wave item 14): DRAFT_ORPHAN_DECISION is logged once per decision id per process, not on every read', async () => {
    const orphan = await decide('pre-processing', 'Q-ZZ-97');
    const first = await captureLogs(() => readDraft());
    expect(first.lines.filter((l) => l.includes('DRAFT_ORPHAN_DECISION') && l.includes(orphan.id))).toHaveLength(1);
    const second = await captureLogs(() => readDraft());
    expect(second.lines.filter((l) => l.includes('DRAFT_ORPHAN_DECISION'))).toEqual([]);
    expect(second.result.omittedAnswers).toBe(1);
    // Fix wave item 10: the count per stage, which a stage's plan and end screen print.
    expect(second.result.omittedByStage).toEqual({ 'pre-processing': 1, 'in-processing': 0, 'post-processing': 0 });
  });

  it('isolation: another organisation\'s project id is NotFoundError', async () => {
    const other = await buildOrg({ label: 'draftrec-b' });
    const theirs = (await addProject(other)).id;
    await expect(readDraft(theirs)).rejects.toBeInstanceOf(NotFoundError);
    await expect(readDraft(projectId, other)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('liveDecisionRows (conflict 23)', () => {
  const content = () => loadContent('0.0.1-fixture');
  const empty = (): SealSourceRows => Object.fromEntries(SEAL_SOURCE_TABLES.map((t) => [t, []])) as unknown as SealSourceRows;
  const version = (id: string, stage: Stage, questionId: string, versionNumber: number, status = 'done') => ({ id, stage, questionId, versionNumber, status, scopeAnswer: null });

  it('cuts every version of a question whose current version the running content does not hold in that stage, withdrawn or moved included', () => {
    const rows = { ...empty(), decision_versions: [
      version('a1', 'pre-processing', 'Q-PP-12', 1),
      version('z1', 'pre-processing', 'Q-ZZ-99', 1), version('z2', 'pre-processing', 'Q-ZZ-99', 2),
      version('w1', 'pre-processing', 'Q-ZZ-98', 1, 'withdrawn'),
      version('m1', 'pre-processing', 'Q-IP-01', 1),
    ] } as unknown as SealSourceRows;
    const out = liveDecisionRows(rows, content());
    expect(out.rows.decision_versions.map((r) => r.id)).toEqual(['a1']);
    expect([...out.orphans].sort()).toEqual(['m1', 'w1', 'z2']);
    // A withdrawn current version is cut (the planner would refuse it) but is not an answer left out of the report.
    expect(out.omittedAnswers).toBe(2);
  });

  it('keeps the rows as they are when every current decision is in the running content', () => {
    const rows = { ...empty(), decision_versions: [version('a1', 'pre-processing', 'Q-PP-12', 1)] } as unknown as SealSourceRows;
    const out = liveDecisionRows(rows, content());
    expect(out).toEqual({ rows, orphans: [], omittedAnswers: 0 });
  });
});

describe('conflict 3 (a): the documents service loads the renderer only on the issue path', () => {
  it('lib/data/documents.ts has no static value import of @/lib/documents/render', () => {
    const src = readFileSync(join(process.cwd(), 'lib', 'data', 'documents.ts'), 'utf8');
    const staticImports = [...src.matchAll(/^import\s+(?!type\b)[^;]*?from\s+'@\/lib\/documents\/render(?:\/[^']*)?';/gm)];
    expect(staticImports.map((m) => m[0])).toEqual([]);
    expect(src).toMatch(/await import\('@\/lib\/documents\/render'\)/);
  });
});
