import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { OrgContext, TenantTx } from '@/lib/data/tenant';
import type { Actor, Stage } from '@/types/record';
import type { SaveDecisionRequest } from '@/types/api';

const ctx = { orgId: 'o1', role: 'owner' } as unknown as OrgContext;
const actor: Actor = { userId: 'u1', role: 'owner' };
const tx = {} as unknown as TenantTx;
const REQ = '3f2b8c1e-5a47-4d0b-9e61-7c2d4a9b0f13';
const version = { id: 'v1', projectId: 'p', stage: 'pre-processing' as Stage, questionId: 'Q-PP-01', status: 'partly' as const, enteredById: 'u1' };
const body = { projectId: 'p' } as unknown as SaveDecisionRequest & { projectId: string };

const STAGE_LIST: Stage[] = ['pre-processing', 'in-processing', 'post-processing'];
const ZERO_COUNTS = {
  questions: 0, noDecision: 0, byStatus: { done: 0, partly: 0, not_yet: 0, not_applicable: 0 },
  doneWithoutEvidence: 0, openFindings: 0, openFindingsWithoutMitigation: 0, openMitigations: 0,
  overdueMitigations: 0, acceptedRisks: 0, documentsIssued: 0, notApplicableByGate: 0,
};
const ZERO_COUNTS_BY_STAGE = Object.fromEntries(STAGE_LIST.map((s) => [s, ZERO_COUNTS]));

const STUB_FILES = [
  'lib/data/findings.ts', 'lib/data/teamFindings.ts', 'lib/data/decisions.ts', 'lib/data/followup.ts',
  'lib/data/seals.ts', 'lib/seal/ids.ts', 'lib/data/reviews.ts', 'lib/data/documents.ts', 'lib/data/projects.ts',
  'lib/data/agreements.ts', 'lib/content/loader.ts', 'lib/content/resources.ts', 'lib/content/suggestions.ts',
  'lib/data/framework.ts',
];
const PRODUCERS = ['DEC-a', 'FND-a', 'FND-b', 'FUP', 'REV-a', 'REV-b', 'DOC-a', 'DOC-b', 'PRJ', 'ORG', 'CNT', 'SUG', 'EVD', 'AUTHZ', 'EXP', 'ACC-a', 'MEM', 'DEC-b', 'UI'];

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });
}
function grep(re: RegExp, dirs: string[]): string[] {
  return dirs.flatMap(filesUnder).flatMap((f) =>
    readFileSync(f, 'utf8').split('\n').flatMap((line, i) => (re.test(line) ? [`${f}:${i + 1}`] : [])));
}

/**
 * The contract's "Typed stubs" table, one row per stubbed export, and the one place a unit name is
 * written next to an export. A row is checked only while its own marker sits directly above its
 * export (`stubbed`), so a producer that fills a body and deletes the marker never turns this red
 * (contract rule 6); the marker case below checks that each marker names this table's unit.
 */
type Row = { file: string; unit: string; fn: string; args: () => unknown[]; expected: 'throws' | unknown };
const EMPTY_BY_STAGE = Object.fromEntries(STAGE_LIST.map((s) => [s, []]));
const throws = 'throws' as const;
const ROWS: Row[] = [
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'saveDecision', args: () => [ctx, actor, body, 'd'], expected: throws },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'currentDecisions', args: () => [ctx, 'p', 'pre-processing'], expected: new Map() },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'onShortfallSaved', args: () => [tx, ctx, version, { requestId: REQ, digest: 'd' }], expected: null },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'listFindings', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'sealsIncludingRows', args: () => [ctx, ['a']], expected: new Map() },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'stageView', args: () => [ctx, 'p', '2026-11-02'], expected: ZERO_COUNTS_BY_STAGE },
  { file: 'lib/data/agreements.ts', unit: 'ORG', fn: 'currentAgreement', args: () => [ctx], expected: null },
  { file: 'lib/content/loader.ts', unit: 'CNT', fn: 'runningContent', args: () => [], expected: throws },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'withdrawDecision', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'decisionHistory', args: () => [ctx, 'p', 'Q-PP-01'], expected: [] },
  { file: 'lib/data/decisions.ts', unit: 'DEC-a', fn: 'currentDecisionRows', args: () => [tx, 'p', 'pre-processing'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'addMitigation', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'updateMitigation', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'acceptRisk', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'reopenFinding', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'withdrawFinding', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'closeByDecision', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'findingDetail', args: () => [ctx, 'p', 'f'], expected: throws },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'mitigationHistory', args: () => [ctx, 'p', 'm'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'findingsToCloseByDecision', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'acceptedRisksToLookAgain', args: () => [ctx, 'p', '2026-11-02'], expected: [] },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'openShortfallForQuestion', args: () => [ctx, 'p', 'Q-PP-01'], expected: null },
  { file: 'lib/data/findings.ts', unit: 'FND-a', fn: 'mitigationOwnerCandidates', args: () => [ctx], expected: [] },
  { file: 'lib/data/teamFindings.ts', unit: 'FND-b', fn: 'raiseTeamFinding', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'openMitigationsByStage', args: () => [ctx, 'p', '2026-11-02'], expected: EMPTY_BY_STAGE },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'myMitigations', args: () => [ctx, 'u1', '2026-11-02'], expected: [] },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'ownerCannotAct', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/followup.ts', unit: 'FUP', fn: 'stageFollowUpCounts', args: () => [ctx, 'p', 'pre-processing', '2026-11-02'], expected: { openFindings: 0, overdueMitigations: 0 } },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'sealStageReview', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'checkSeal', args: () => [ctx, 's'], expected: throws },
  { file: 'lib/data/seals.ts', unit: 'REV-a', fn: 'listSeals', args: () => [ctx, 'r'], expected: [] },
  { file: 'lib/seal/ids.ts', unit: 'REV-a', fn: 'stageSnapshotIds', args: () => [tx, 'p', 'pre-processing'], expected: throws },
  { file: 'lib/seal/ids.ts', unit: 'REV-a', fn: 'manifestIds', args: () => [{}], expected: throws },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'openStageReview', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'sealPreview', args: () => [ctx, 'r'], expected: throws },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'listStageReviews', args: () => [ctx, 'p'], expected: [] },
  { file: 'lib/data/reviews.ts', unit: 'REV-b', fn: 'changedSinceSeal', args: () => [ctx, 'r'], expected: null },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'previewDocument', args: () => [ctx, actor, {}], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'issueDocument', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'listDocuments', args: () => [ctx, { projectId: 'p' }], expected: [] },
  { file: 'lib/data/documents.ts', unit: 'DOC-a', fn: 'readDocumentPdf', args: () => [ctx, 'd'], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-b', fn: 'withdrawDocument', args: () => [ctx, actor, {}, 'd'], expected: throws },
  { file: 'lib/data/documents.ts', unit: 'DOC-b', fn: 'readDocumentText', args: () => [ctx, 'd'], expected: throws },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'archiveProject', args: () => [ctx, actor, 'p'], expected: throws },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'unarchiveProject', args: () => [ctx, actor, 'p'], expected: throws },
  { file: 'lib/data/projects.ts', unit: 'PRJ', fn: 'projectHasRecords', args: () => [tx, 'p'], expected: throws },
  { file: 'lib/content/suggestions.ts', unit: 'SUG', fn: 'controlsForQuestion', args: () => [{}, 'Q-PP-01', []], expected: { first: [], rest: [] } },
  { file: 'lib/content/suggestions.ts', unit: 'SUG', fn: 'controlsForArea', args: () => [{}, 'A-1'], expected: [] },
  { file: 'lib/content/loader.ts', unit: 'CNT', fn: 'loadContent', args: () => ['5.0.0'], expected: throws },
  { file: 'lib/content/loader.ts', unit: 'CNT', fn: 'questionsInStage', args: () => [{}, 'pre-processing'], expected: throws },
  { file: 'lib/content/loader.ts', unit: 'CNT', fn: 'reasonCodesFor', args: () => [{}, 'not_yet'], expected: throws },
  { file: 'lib/content/loader.ts', unit: 'CNT', fn: 'questionApplies', args: () => [{}, 'Q-PP-13', null], expected: throws },
  { file: 'lib/content/resources.ts', unit: 'CNT', fn: 'loadResources', args: () => [], expected: throws },
  { file: 'lib/data/framework.ts', unit: 'CNT', fn: 'resolveRunningContentVersion', args: () => [tx], expected: throws },
  { file: 'lib/data/framework.ts', unit: 'CNT', fn: 'contentRefById', args: () => [tx, 'fv_1'], expected: throws },
];


/** True while `fn` is exported directly below its own `// CONTRACT_STUB: <unit>` marker in `file`. */
function stubbed(file: string, unit: string, fn: string): boolean {
  return new RegExp('// CONTRACT_STUB: ' + unit + '\\s*\\n\\s*export (async )?(function|const) ' + fn + '\\b').test(readFileSync(file, 'utf8'));
}

/** The release case reads the list strictly: a missing export is a failure, never an empty list. */
function pendingRoutesOf(lists: { PENDING_ROUTES?: readonly string[] }): readonly string[] {
  if (!Array.isArray(lists.PENDING_ROUTES)) throw new Error('lib/authz/routeActions.ts does not export PENDING_ROUTES');
  return lists.PENDING_ROUTES;
}

describe('no contract stubs', () => {
  it('NFR-MNT-01 (release): the release case fails when PENDING_ROUTES is not exported, instead of reading it as empty', () => {
    expect(() => pendingRoutesOf({})).toThrow(/does not export PENDING_ROUTES/);
    expect(() => pendingRoutesOf({ PENDING_ROUTES: undefined })).toThrow(/does not export PENDING_ROUTES/);
    expect(() => pendingRoutesOf({ PENDING_ROUTES: 'app/x' as unknown as string[] })).toThrow(/does not export PENDING_ROUTES/);
    expect(pendingRoutesOf({ PENDING_ROUTES: [] })).toEqual([]);
    expect(pendingRoutesOf({ PENDING_ROUTES: ['app/x/route.ts'] })).toEqual(['app/x/route.ts']);
  });

  // An unset run reports this case as skipped, not passed: a release candidate runs it with RELEASE_CANDIDATE=1.
  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('NFR-MNT-01 (release): no CONTRACT_STUB or SLOT_STUB marker and no pending route remains', async () => {
    expect(grep(/CONTRACT_STUB|SLOT_STUB/, ['app', 'components', 'lib'])).toEqual([]);
    const lists = (await import('@/lib/authz/routeActions')) as { PENDING_ROUTES?: readonly string[] };
    expect(pendingRoutesOf(lists)).toEqual([]);
  });

  for (const r of ROWS) {
    it(`NFR-MNT-01: ${r.file} ${r.fn} (${r.unit}) ${r.expected === 'throws' ? 'throws NotImplementedError' : 'returns the empty value'} while its marker is in place`, async () => {
      if (!stubbed(r.file, r.unit, r.fn)) return;
      const mod = (await import(/* @vite-ignore */ '@/' + r.file.replace(/\.ts$/, ''))) as Record<string, (...a: unknown[]) => unknown>;
      const call = async () => mod[r.fn](...r.args());
      if (r.expected === 'throws') {
        await expect(call()).rejects.toMatchObject({ status: 501, code: 'not_implemented', extra: { unit: r.unit } });
      } else {
        expect(await call()).toEqual(r.expected);
      }
    });
  }

  it('NFR-MNT-01: every CONTRACT_STUB marker names the producer the table gives for the export below it', () => {
    const seen: Array<{ file: string; fn: string; marker: string; row: string | undefined }> = [];
    for (const file of STUB_FILES) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        const marker = /\/\/ CONTRACT_STUB: (\S+)/.exec(line);
        if (!marker) return;
        const fn = /^export (?:async )?(?:function|const) (\w+)/.exec(lines[i + 1] ?? '')?.[1] ?? '(not an export)';
        seen.push({ file, fn, marker: marker[1], row: ROWS.find((r) => r.file === file && r.fn === fn)?.unit });
      });
    }
    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) expect(s, `${s.file} ${s.fn}`).toEqual({ ...s, row: s.marker });
    for (const r of ROWS) expect(PRODUCERS, `${r.file} ${r.fn}`).toContain(r.unit);
    // a row that is still stubbed has the marker for its own producer (stubbed() is the one gate every case uses)
    for (const r of ROWS) if (stubbed(r.file, r.unit, r.fn)) expect(seen.some((s) => s.file === r.file && s.fn === r.fn && s.marker === r.unit), `${r.file} ${r.fn}`).toBe(true);
  });

  it('NFR-MNT-01: a stub is a function whose marker is the line directly above its export, and no stub file touches the database', () => {
    for (const f of STUB_FILES) {
      const src = readFileSync(f, 'utf8');
      const lines = src.split('\n');
      lines.forEach((line, i) => {
        if (!/\/\/ CONTRACT_STUB: /.test(line)) return;
        expect({ f, line: i + 1, nextLine: lines[i + 1].startsWith('export ') }).toEqual({ f, line: i + 1, nextLine: true });
      });
      // a stub reads and writes nothing: its only runtime import is the error class (and, for the framework file, its own)
      expect(src, f).not.toMatch(/withOrg\(|from '@\/lib\/data\/(identity|preauth|connection)'|\$queryRaw|\$executeRaw/);
    }
  });
});
