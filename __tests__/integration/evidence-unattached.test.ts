import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { DELETE } from '@/app/api/v1/orgs/[slug]/evidence/[evidenceId]/route';
import { unattachedEvidence, unattachedEvidenceIn } from '@/lib/data/evidence';
import { withOrg } from '@/lib/data/tenant';
import { resetDb, testDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { clearSession, sessionFor } from '../helpers/authSession';
import { addDecision, addEvidence, addFinding, addMitigationVersion, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

let fx: OrgFixture;
let p: { id: string };
let cv: { contentVersionId: string };

beforeEach(async () => {
  await resetDb();
  cv = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  p = await addProject(fx);
  clearSession();
});

/** Lines of `grep -rnE pattern dirs` as { file, text }, comment lines left out. */
function grep(pattern: RegExp, dirs: string[]): Array<{ file: string; text: string }> {
  const out = execSync(`grep -rnE ${JSON.stringify(pattern.source)} ${dirs.join(' ')} --include=*.ts --include=*.tsx || true`, { env: { ...process.env, NO_COLOR: '1' } })
    .toString().replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim().split('\n').filter(Boolean);
  return out.map((line) => {
    const m = /^([^:]+):(\d+):(.*)$/.exec(line);
    if (!m) throw new Error(`grep -n output did not parse -- "${line}"`);
    return { file: m[1], text: m[3] };
  }).filter((h) => !h.text.trim().startsWith('//') && !h.text.trim().startsWith('*'));
}

async function threeItems() {
  const mine = await addEvidence(fx, p.id, { kind: 'file' }, 'assessor');
  const theirs = await addEvidence(fx, p.id, { kind: 'link', url: 'https://e.org/a' }, 'admin');
  const linked = await addEvidence(fx, p.id, { kind: 'file' }, 'assessor');
  await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId: cv.contentVersionId, status: 'done', evidenceIds: [linked.id] });
  return { mine, theirs, linked };
}

describe('unattached evidence (FR-EVD-06)', () => {
  it("FR-EVD-06: unattached evidence lists only the uploader's items when asked, and linked items never", async () => {
    const { mine, theirs } = await threeItems();
    const ctx = ctxFor(fx, 'assessor');
    expect((await unattachedEvidence(ctx, p.id, null)).map((e) => e.id)).toEqual([mine.id, theirs.id]);
    expect((await unattachedEvidence(ctx, p.id, fx.members.assessor.userId)).map((e) => e.id)).toEqual([mine.id]);
    expect((await unattachedEvidence(ctx, p.id, fx.members.admin.userId)).map((e) => e.id)).toEqual([theirs.id]);
    expect((await unattachedEvidence(ctx, null, null)).map((e) => e.id)).toEqual([mine.id, theirs.id]);
  });

  it('FR-EVD-06: an item that only a mitigation version names is attached, and one of another project is not listed', async () => {
    const { mine } = await threeItems();
    const viaMitigation = await addEvidence(fx, p.id, { kind: 'file' }, 'assessor');
    const finding = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
    await addMitigationVersion(fx, finding.id, { status: 'planned', owner: 'assessor', dueDate: '2026-12-01', evidenceIds: [viaMitigation.id] });
    const other = await addProject(fx, { name: 'Other' });
    await addEvidence(fx, other.id, { kind: 'file' }, 'assessor');
    const ctx = ctxFor(fx, 'assessor');
    expect((await unattachedEvidence(ctx, p.id, fx.members.assessor.userId)).map((e) => e.id)).toEqual([mine.id]);
    expect(await unattachedEvidence(ctx, other.id, fx.members.admin.userId)).toEqual([]);
  });

  it('FR-EVD-06 NFR-INT-10: unattachedEvidenceIn inside one transaction returns the same rows as unattachedEvidence for every argument pair', async () => {
    const { mine, theirs } = await threeItems();
    const ctx = ctxFor(fx, 'assessor');
    const pairs: Array<[string | null, string | null]> = [[p.id, null], [p.id, fx.members.assessor.userId], [p.id, fx.members.admin.userId], [null, null], [null, fx.members.admin.userId]];
    for (const [projectId, uploader] of pairs) {
      const viaCtx = await unattachedEvidence(ctx, projectId, uploader);
      const viaTx = await withOrg(ctx, (tx) => unattachedEvidenceIn(tx, projectId, uploader), { isolationLevel: 'RepeatableRead' });
      expect(viaTx).toEqual(viaCtx);
    }
    expect((await withOrg(ctx, (tx) => unattachedEvidenceIn(tx, p.id, null))).map((e) => e.id)).toEqual([mine.id, theirs.id]);
  });

  it('FR-EVD-06: no page or component passes null as the uploader, except the team export', () => {
    const hits = grep(/unattachedEvidence(In)?\(/, ['app', 'components', 'lib/question', 'lib/findings']);
    for (const h of hits) expect(h.file.includes('/export/') || !/unattachedEvidence(In)?\([^)]*,\s*null\s*\)/.test(h.text)).toBe(true);
  });

  it("NFR-MNT-01 FR-EVD-06: lib/data/evidence.ts holds no CONTRACT_STUB marker, so both unattached functions are this unit's bodies and not K0b's stubs", () => {
    expect(readFileSync('lib/data/evidence.ts', 'utf8')).not.toMatch(/CONTRACT_STUB/);
  });

  it('NFR-MNT-01: the two guards RM left pinned to [] are gone with their blocks', () => {
    expect(grep(/questionExistsInBank/, ['app', 'lib', 'components'])).toEqual([]);
    expect(readFileSync('__tests__/integration/trigger-enumeration.test.ts', 'utf8')).not.toMatch(/questionExistsInBank|resolution\.matches/);
  });

  it('NFR-MNT-01 (R12-12): lib/data/evidence.ts keeps no evidence-level export that nothing uses', () => {
    const src = readFileSync('lib/data/evidence.ts', 'utf8');
    const defined = (n: string) => new RegExp(`export (const|function) ${n}\\b`).test(src);
    const usedElsewhere = (n: string) => grep(new RegExp(`\\b${n}\\b`), ['app', 'components', 'lib']).some((h) => h.file !== 'lib/data/evidence.ts');
    for (const n of ['EVIDENCE_COUNT_INCLUDE', 'withDerivedEvidenceLevel']) expect(!defined(n) || usedElsewhere(n), n).toBe(true);
    expect(!defined('deriveEvidenceLevel') || defined('withDerivedEvidenceLevel'), 'deriveEvidenceLevel').toBe(true);
  });

  it('FR-AUTHZ-02 FR-EVD-06: DELETE .../evidence/<id> of an unattached upload answers 404 and the row stays', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file' }, 'assessor');
    sessionFor(fx.members.owner.userId);
    const res = await DELETE(new NextRequest('http://localhost/probe', { method: 'DELETE' }), { params: Promise.resolve({ slug: fx.org.slug, evidenceId: ev.id }) });
    expect(res.status).toBe(404);
    expect(await testDb.evidence.count({ where: { id: ev.id } })).toBe(1);
  });
});
