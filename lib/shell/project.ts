import { identityPassesGates, type Identity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { NotFoundError, withOrg, type OrgContext } from '@/lib/data/tenant';
import { currentDecisionRows } from '@/lib/data/decisions';
import { openQuestionIds } from '@/lib/data/projects';
import { questionApplies, questionsInStage, runningContent } from '@/lib/content/loader';
import { isUuid } from '@/lib/shell/nav';
import { STAGES, type ScopeAnswer } from '@/types/record';
import type { ShellProject } from '@/lib/shell/types';

/**
 * The project in context for the rail's project block and the narrow top bar (owner ruling R4), read on the server by the
 * signed-in layout's `@project` slot (app/(authenticated)/@project/…). Imported by server code only.
 *
 * The same gates as the project page (S2), in its order: requireIdentity(), which the slot's page calls and passes in (so
 * the gate is in the page's own code, __tests__/lint/authenticated-page-gate.test.ts); then, for a person held at a sign-in gate,
 * nothing (S3: loadShellData's rule, so S-05, S-21 and S-29 show no project); an id that is not a UUID is no project and
 * reads nothing; requireOrgContextFor(userId, slug, 'project:read'); then one tenant-scoped transaction (withOrg, forced
 * row-level security) that reads THIS organisation's project by id and, when it is visible, the current decision of each
 * question per stage. A foreign, deleted or unknown id is a null row, so the answer is null, exactly as for a slug the
 * person is not in (NotFoundError, the only error caught: as in app/(authenticated)/orgs/[slug]/layout.tsx, any other
 * error propagates and surfaces as the page's error, never as a quietly missing block). Null says nothing about whether
 * the project exists; the page itself answers 404.
 *
 * The counts are stageView's own (lib/data/projects.ts, S4): `questions` is the stage's question count from the running
 * content (questionsInStage) and `noDecision` is openQuestionIds over currentDecisionRows, the one rule S-10 counts and
 * Home chooses from. Only the project's id, name and these numbers are returned (S5).
 */
export async function loadShellProject(identity: Identity, address: { slug: string; id: string }): Promise<ShellProject | null> {
  if (!(await identityPassesGates(identity))) return null;
  if (!isUuid(address.id)) return null;
  let ctx: OrgContext;
  try {
    ctx = await requireOrgContextFor(identity.userId, address.slug, 'project:read');
  } catch (e) {
    if (e instanceof NotFoundError) return null;
    throw e;
  }
  return readShellProject(ctx, address.id);
}

/** The tenant-scoped read behind loadShellProject, for a context that has passed the gates. */
async function readShellProject(ctx: OrgContext, projectId: string): Promise<ShellProject | null> {
  const found = await withOrg(ctx, async (tx) => {
    const project = await tx.project.findUnique({ where: { id: projectId }, select: { id: true, name: true } });
    if (project === null) return null;
    const rows = await Promise.all(STAGES.map((s) => currentDecisionRows(tx, projectId, s)));
    return { project, rows };
  });
  if (found === null) return null;
  const content = runningContent();
  const stages = STAGES.map((stage, i) => {
    const questions = questionsInStage(content, stage);
    const current = new Map(found.rows[i].map((r) => [r.questionId, r]));
    const noDecision = openQuestionIds({
      questions, current, applies: (id: string, gate: ScopeAnswer | null) => questionApplies(content, id, gate),
    }).size;
    return { stage, questions: questions.length, noDecision };
  });
  return { id: found.project.id, name: found.project.name, stages };
}
