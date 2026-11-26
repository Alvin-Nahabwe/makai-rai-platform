import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { OrgRole } from '@prisma/client';
import type { Identity } from '@/lib/auth/identity';
import { loadQuestionPanel } from '@/lib/question/panel';
import { requestDigest } from '@/lib/data/idempotency';
import { removeMember } from '@/lib/data/members';
import { deleteAccount } from '@/lib/data/export';
import { DELETE_PHRASE } from '@/lib/export/messages';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * The names S-12's page data carries for members who decided an earlier version of the question and have since left the organisation
 * (`formerDeciders`, lib/question/panel.ts; the owner's "Names from the server"). A draft kept in the browser holds a
 * decider's account id only, so after a page load the form can name such a person only from these. They are the question's own
 * history and nothing else: no former member who never decided a version of it, no decider of another question, no email, no other
 * organisation's people. A deleted account reads as the server holds it after the deletion (FR-EXP-03).
 *
 * People leave through the real paths: `removeMember` (route 26) and `deleteAccount` (route 39).
 */
let fx: OrgFixture;
let project: { id: string };
let contentVersionId: string;

beforeEach(async () => {
  await resetDb();
  contentVersionId = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg();
  project = await addProject(fx);
});

const identity = (role: OrgRole): Identity => ({
  userId: fx.members[role].userId, email: fx.members[role].email, name: fx.members[role].name, platformRole: 'assessor', mustChangePassword: false,
});
const panel = (questionId = 'Q-PP-01', role: OrgRole = 'assessor') =>
  loadQuestionPanel(ctxFor(fx, role), identity(role), { projectId: project.id, stage: 'pre-processing', questionId });
const decided = (role: OrgRole, questionId = 'Q-PP-01') => addDecision(fx, project.id, {
  stage: 'pre-processing', questionId, contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: fx.members[role].userId },
});
const removed = async (role: OrgRole): Promise<void> => {
  const body = { requestId: randomUUID() };
  const userId = fx.members[role].userId;
  await removeMember(ctxFor(fx, 'owner'), { userId: fx.members.owner.userId, role: 'owner' }, { ...body, userId }, requestDigest({ path: { userId }, body }));
};
const named = (role: OrgRole, name = fx.members[role].name) => ({ userId: fx.members[role].userId, name });

describe('the names the page data carries for deciders who have left', () => {
  it('names each member who decided an earlier version of the question and has since left, once, by account id and name only', async () => {
    await decided('reviewer');
    await decided('reviewer');
    await decided('viewer');
    await decided('admin');
    await removed('reviewer');
    await removed('viewer');
    const d = await panel();
    expect(d.formerDeciders).toEqual(expect.arrayContaining([named('reviewer'), named('viewer')]));
    expect(d.formerDeciders).toHaveLength(2);
    for (const u of d.formerDeciders ?? []) expect(Object.keys(u).sort()).toEqual(['name', 'userId']);
  });

  it('leaves out the current version\'s decider, whom the page names as the current version\'s, unless they also decided an earlier one', async () => {
    await decided('admin');
    await decided('reviewer');
    await removed('reviewer');
    expect((await panel()).formerDeciders).toBeUndefined();
    await decided('admin');
    expect((await panel()).formerDeciders).toEqual([named('reviewer')]);
  });

  it('leaves out a decider who is still a member, an outside role, a withdrawal, and the viewer', async () => {
    await decided('admin');
    await decided('assessor');
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done', decidedBy: { kind: 'outside_role', role: 'supervisor' } });
    await addDecision(fx, project.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'withdrawn', withdrawalCode: 'duplicate' });
    expect((await panel()).formerDeciders).toBeUndefined();
  });

  it('leaves out a former member who never decided a version of this question, and the former decider of another question', async () => {
    await decided('reviewer', 'Q-PP-02');
    await decided('admin', 'Q-PP-02');
    await decided('admin');
    await removed('reviewer');
    await removed('viewer');
    expect((await panel('Q-PP-01')).formerDeciders).toBeUndefined();
    expect((await panel('Q-PP-02')).formerDeciders).toEqual([named('reviewer')]);
  });

  it('leaves out another organisation\'s former decider of the same question', async () => {
    const other = await buildOrg({ label: 'other' });
    const theirs = await addProject(other);
    await addDecision(other, theirs.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, status: 'done', decidedBy: { kind: 'member', userId: other.members.reviewer.userId } });
    const body = { requestId: randomUUID() };
    const userId = other.members.reviewer.userId;
    await removeMember(ctxFor(other, 'owner'), { userId: other.members.owner.userId, role: 'owner' }, { ...body, userId }, requestDigest({ path: { userId }, body }));
    await decided('admin');
    expect((await panel()).formerDeciders).toBeUndefined();
  });

  it('FR-EXP-03: a decider who deleted their account reads as the server holds them after the deletion, not by their earlier name', async () => {
    await decided('reviewer');
    await decided('admin');
    await deleteAccount(fx.members.reviewer.userId, { password: fx.members.reviewer.password, phrase: DELETE_PHRASE });
    const d = await panel();
    expect(d.formerDeciders).toEqual([named('reviewer', 'Deleted user')]);
    expect(JSON.stringify(d.formerDeciders)).not.toContain(fx.members.reviewer.name);
  });
});
