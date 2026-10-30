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

describe('no contract stubs', () => {
  it('NFR-MNT-01 (release): no CONTRACT_STUB or SLOT_STUB marker and no pending route remains', async () => {
    if (process.env.RELEASE_CANDIDATE !== '1') return;
    expect(grep(/CONTRACT_STUB|SLOT_STUB/, ['app', 'components', 'lib'])).toEqual([]);
    const lists = (await import('@/lib/authz/routeActions')) as { PENDING_ROUTES?: readonly string[] };
    expect(lists.PENDING_ROUTES ?? []).toEqual([]);
  });

  it('NFR-MNT-01: every stub still in place names its producer; writes throw, list reads return empty', async () => {
    // Each case runs only while that stub's own marker line sits directly above its export, so a producer filling one stub, or several over more than one task, never turns this red, provided it deletes each marker as it fills the body (contract rule 6; verify-r7 R7-B4-GATE).
    const stubbed = (f: string, unit: string, fn: string) => new RegExp('// CONTRACT_STUB: ' + unit + '\\s*\\n\\s*export (async )?(function|const) ' + fn + '\\b').test(readFileSync(f, 'utf8'));
    if (stubbed('lib/data/decisions.ts', 'DEC-a', 'saveDecision')) await expect(import('@/lib/data/decisions').then((m) => m.saveDecision(ctx, actor, body, 'd'))).rejects.toMatchObject({ status: 501, code: 'not_implemented', extra: { unit: 'DEC-a' } });
    if (stubbed('lib/data/decisions.ts', 'DEC-a', 'currentDecisions')) expect(await (await import('@/lib/data/decisions')).currentDecisions(ctx, 'p', 'pre-processing')).toEqual(new Map());
    if (stubbed('lib/data/findings.ts', 'FND-a', 'onShortfallSaved')) expect(await (await import('@/lib/data/findings')).onShortfallSaved(tx, ctx, version, { requestId: REQ, digest: 'd' })).toBeNull();
    if (stubbed('lib/data/findings.ts', 'FND-a', 'listFindings')) expect(await (await import('@/lib/data/findings')).listFindings(ctx, 'p')).toEqual([]);
    if (stubbed('lib/data/seals.ts', 'REV-a', 'sealsIncludingRows')) expect(await (await import('@/lib/data/seals')).sealsIncludingRows(ctx, ['a'])).toEqual(new Map());
    if (stubbed('lib/data/projects.ts', 'PRJ', 'stageView')) expect(await (await import('@/lib/data/projects')).stageView(ctx, 'p', '2026-11-02')).toEqual(ZERO_COUNTS_BY_STAGE);
    if (stubbed('lib/data/agreements.ts', 'ORG', 'currentAgreement')) expect(await (await import('@/lib/data/agreements')).currentAgreement(ctx)).toBeNull();
    const loader = await import('@/lib/content/loader');
    if (stubbed('lib/content/loader.ts', 'CNT', 'runningContent')) expect(() => loader.runningContent()).toThrow(expect.objectContaining({ code: 'not_implemented', extra: { unit: 'CNT' } }));
    for (const f of STUB_FILES) for (const m of readFileSync(f, 'utf8').matchAll(/\/\/ CONTRACT_STUB: (\S+)/g)) expect(PRODUCERS).toContain(m[1]);
  });

  /**
   * The rest of the contract's "Typed stubs" table, one row per export, under the same gate: a row is
   * checked only while its own marker sits directly above its export.
   */
  type Row = { file: string; unit: string; fn: string; args: () => unknown[]; expected: 'throws' | unknown };
  const EMPTY_BY_STAGE = Object.fromEntries(STAGE_LIST.map((s) => [s, []]));
  const throws = 'throws' as const;
  const ROWS: Row[] = [
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

  const stubbedNow = (r: Row) => new RegExp('// CONTRACT_STUB: ' + r.unit + '\\s*\\n\\s*export (async )?(function|const) ' + r.fn + '\\b').test(readFileSync(r.file, 'utf8'));
  for (const r of ROWS) {
    it(`NFR-MNT-01: ${r.file} ${r.fn} (${r.unit}) ${r.expected === 'throws' ? 'throws NotImplementedError' : 'returns the empty value'} while its marker is in place`, async () => {
      if (!stubbedNow(r)) return;
      const mod = (await import(/* @vite-ignore */ '@/' + r.file.replace(/\.ts$/, ''))) as Record<string, (...a: unknown[]) => unknown>;
      const call = async () => mod[r.fn](...r.args());
      if (r.expected === 'throws') {
        await expect(call()).rejects.toMatchObject({ status: 501, code: 'not_implemented', extra: { unit: r.unit } });
      } else {
        expect(await call()).toEqual(r.expected);
      }
    });
  }

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
