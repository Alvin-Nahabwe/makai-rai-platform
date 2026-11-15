import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Identity } from '@/lib/auth/identity';
import { STAGES } from '@/types/record';
import { stageView } from '@/lib/data/projects';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * The rail's project block loader (lane 3 task 1; owner ruling R4; obligations S1 to S5): lib/shell/project.ts. It passes
 * the project page's gates (requireIdentity, then requireOrgContextFor with 'project:read', then a tenant-scoped read of
 * this organisation's project by id), so a foreign, unknown or malformed id, a slug the person is not a member of, and a
 * person held at a sign-in gate get no block, and its counts are stageView's own.
 *
 * The slot's page passes the identity its requireIdentity() gave; here the identity under test is passed instead, and
 * identityPassesGates is real and reads the database.
 */
import { loadShellProject as load } from '@/lib/shell/project';

let who: Identity;
const loadShellProject = (address: { slug: string; id: string }) => load(who, address);

const identityOf = (userId: string, over: Partial<Identity> = {}): Identity =>
  ({ userId, email: `${userId}@fixture.test`, name: 'Fixture', platformRole: 'assessor', mustChangePassword: false, ...over });

let fx: OrgFixture;
let other: OrgFixture;
let p: { id: string };
let cv: string;

beforeEach(async () => {
  await resetDb();
  cv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  other = await buildOrg();
  p = await addProject(fx, { name: 'Antenatal Risk Triage Model' });
  const stage = 'pre-processing' as const;
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-01', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-02', contentVersionId: cv, status: 'partly' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-03', contentVersionId: cv, status: 'done' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-03', contentVersionId: cv, status: 'withdrawn', withdrawalCode: 'entered_in_error' });
  await addDecision(fx, p.id, { stage, questionId: 'Q-PP-GATE-SENSITIVE', contentVersionId: cv, status: null, scopeAnswer: 'no' });
  await addDecision(fx, p.id, { stage: 'post-processing', questionId: 'Q-PO-01', contentVersionId: cv, status: 'done' });
  who = identityOf(fx.members.viewer.userId);
});

describe('the project block loader (R4, S2 to S5)', () => {
  it('S4: a member sees the project\'s name and, per stage, the question count and "no decision" count stageView gives', async () => {
    const block = await loadShellProject({ slug: fx.org.slug, id: p.id });
    expect(block).not.toBeNull();
    const view = await stageView(ctxFor(fx, 'viewer'), p.id, '2026-11-15');
    expect(block!.stages).toEqual(STAGES.map((stage) => ({ stage, questions: view[stage].questions, noDecision: view[stage].noDecision })));
    // The fixture: pre-processing and post-processing are started, in-processing is not.
    expect(block!.stages[0].noDecision).toBeLessThan(block!.stages[0].questions);
    expect(block!.stages[1].noDecision).toBe(block!.stages[1].questions);
    expect(block!.stages[2].noDecision).toBe(block!.stages[2].questions - 1);
  });

  it('S5: only the project\'s id, its name and the per-stage numbers are returned', async () => {
    const block = await loadShellProject({ slug: fx.org.slug, id: p.id });
    expect(Object.keys(block!).sort()).toEqual(['id', 'name', 'stages']);
    expect(block).toMatchObject({ id: p.id, name: 'Antenatal Risk Triage Model' });
    for (const s of block!.stages) expect(Object.keys(s).sort()).toEqual(['noDecision', 'questions', 'stage']);
  });

  it('S2: every role of the organisation sees it (project:read)', async () => {
    for (const role of ['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const) {
      who = identityOf(fx.members[role].userId);
      expect(await loadShellProject({ slug: fx.org.slug, id: p.id }), role).not.toBeNull();
    }
  });

  it('S2: another organisation\'s project id under this slug gives no block, as an unknown id does', async () => {
    const foreign = await addProject(other, { name: 'Not yours' });
    expect(await loadShellProject({ slug: fx.org.slug, id: foreign.id })).toBeNull();
    expect(await loadShellProject({ slug: fx.org.slug, id: randomUUID() })).toBeNull();
  });

  it('S2: a malformed id gives no block and no throw', async () => {
    for (const id of ['new', 'not-a-uuid', `${p.id}x`, "'; select 1; --"]) {
      expect(await loadShellProject({ slug: fx.org.slug, id }), id).toBeNull();
    }
  });

  it('S2: a slug the person is not a member of, or that does not exist, gives no block, even for a real project there', async () => {
    const theirs = await addProject(other, { name: 'Theirs' });
    expect(await loadShellProject({ slug: other.org.slug, id: theirs.id })).toBeNull();
    expect(await loadShellProject({ slug: `no-such-org-${randomUUID()}`, id: p.id })).toBeNull();
  });

  it('S3: a person held at a sign-in gate gets no block (a password change due; a legal text not accepted)', async () => {
    who = identityOf(fx.members.owner.userId, { mustChangePassword: true });
    expect(await loadShellProject({ slug: fx.org.slug, id: p.id })).toBeNull();
    const unaccepted = await buildOrg({ acceptances: 'none' });
    const theirs = await addProject(unaccepted, { name: 'Gated' });
    who = identityOf(unaccepted.members.owner.userId);
    expect(await loadShellProject({ slug: unaccepted.org.slug, id: theirs.id })).toBeNull();
  });

  it('an archived project shows its block too (its read-only pages still exist)', async () => {
    const archived = await addProject(fx, { name: 'Archived one', archived: true });
    expect(await loadShellProject({ slug: fx.org.slug, id: archived.id })).toMatchObject({ id: archived.id, name: 'Archived one' });
  });
});
