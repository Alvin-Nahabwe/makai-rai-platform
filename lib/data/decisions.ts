/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import { withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type { Actor, DecisionVersionRow, FieldError, Stage, WriteOutcome } from '@/types/record';
import type { ContentRef, DecisionVersionView, SaveDecisionRequest, WithdrawDecisionRequest } from '@/types/api';
import { NotImplementedError, ValidationFailed } from '@/lib/http/errors';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { assertEvidenceAttachable } from '@/lib/data/evidenceGuard';
import { memberHistory } from '@/lib/data/views';
import { resolveRunningContentVersion } from '@/lib/data/framework';
import { loadContent } from '@/lib/content/loader';
import { utcPlus14Date, validateDecisionFields } from '@/lib/decision/rules';
import { M11, REQUEST_MESSAGES } from '@/lib/decision/copy';

/**
 * Decision service (FR-DEC-01 to 05, 07 to 09): the decision record on the server. Every read and write runs
 * inside `withOrg`, so row-level security scopes it to the context's organisation; a project of another
 * organisation is not found (NFR-SEC-02).
 */

/** The order fields are reported in: the request's own order, so a summary lists them as the form does. */
const FIELD_ORDER = ['questionId', 'stage', 'status', 'scopeAnswer', 'optionsInPlace', 'reasonCode', 'reason', 'decidedBy', 'declaredDate', 'evidenceIds'];
const byField = (a: FieldError, b: FieldError) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field);

/** The database clock, so the latest accepted declared date is the received date's (FR-DEC-02), not this host's. */
async function dbNow(tx: TenantTx): Promise<Date> {
  const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS "now"`;
  return now;
}

/**
 * FR-DEC-02: the save is valid against the content version published and running now, which it will store
 * (5.3 item 6, obligation D5): the question exists in it and belongs to the stated stage; the field rules of
 * `validateDecisionFields` hold with today taken from the database clock in UTC+14; a member decider is a
 * current or former member of this organisation (`memberHistory` reads 'never' for anyone else, the platform
 * administrator and members of other organisations included); the evidence ids are distinct and evidence of
 * this project. Every problem found is thrown together in one `ValidationFailed`, in field order.
 */
async function checkSave(tx: TenantTx, a: SaveDecisionRequest & { projectId: string }): Promise<ContentRef> {
  const content = await resolveRunningContentVersion(tx);
  const question = loadContent(content.semver).questions.get(a.questionId);
  const errors: FieldError[] = [];
  if (question === undefined) {
    errors.push({ field: 'questionId', message: REQUEST_MESSAGES.questionId });
  } else {
    if (question.stage !== a.stage) errors.push({ field: 'stage', message: REQUEST_MESSAGES.stage });
    errors.push(...validateDecisionFields({
      questionType: question.type, options: question.options ?? [], reasonCodes: loadContent(content.semver).reasonCodes,
      status: a.status, scopeAnswer: a.scopeAnswer, optionsInPlace: a.optionsInPlace, reasonCode: a.reasonCode, reason: a.reason,
      decidedBy: a.decidedBy, declaredDate: a.declaredDate,
    }, utcPlus14Date(await dbNow(tx))));
  }
  if (a.decidedBy.kind === 'member' && !errors.some((e) => e.field === 'decidedBy')) {
    const history = await memberHistory(tx, [a.decidedBy.userId]);
    if (history.get(a.decidedBy.userId) === 'never') errors.push({ field: 'decidedBy', message: M11.decidedBy });
  }
  if (new Set(a.evidenceIds).size !== a.evidenceIds.length) {
    errors.push({ field: 'evidenceIds', message: REQUEST_MESSAGES.evidenceIds });
  } else {
    try {
      await assertEvidenceAttachable(tx, a.projectId, a.evidenceIds);
    } catch (e) {
      // Only the guard's own refusal is merged, so its field joins the others in one answer; anything else propagates.
      if (!(e instanceof ValidationFailed)) throw e;
      errors.push(...(e.extra?.fields ?? []));
    }
  }
  if (errors.length > 0) throw new ValidationFailed(errors.sort(byField));
  return content;
}

export async function saveDecision(
  ctx: OrgContext, actor: Actor, a: SaveDecisionRequest & { projectId: string }, digest: string,
): Promise<WriteOutcome<DecisionVersionView>> {
  return withOrg(ctx, async (tx) => {
    await assertProjectWritable(tx, a.projectId);
    await checkSave(tx, a);
    throw new NotImplementedError('DEC-a');
  });
}

// CONTRACT_STUB: DEC-a
export async function withdrawDecision(
  ctx: OrgContext, actor: Actor, a: WithdrawDecisionRequest & { projectId: string; questionId: string }, digest: string,
): Promise<WriteOutcome<DecisionVersionView>> {
  throw new NotImplementedError('DEC-a');
}

/** Key: question id. A withdrawal is a current version. */
// CONTRACT_STUB: DEC-a
export async function currentDecisions(
  ctx: OrgContext, projectId: string, stage: Stage,
): Promise<Map<string, DecisionVersionView>> {
  return new Map();
}

/** Newest first. */
// CONTRACT_STUB: DEC-a
export async function decisionHistory(
  ctx: OrgContext, projectId: string, questionId: string,
): Promise<DecisionVersionView[]> {
  return [];
}

// CONTRACT_STUB: DEC-a
export async function currentDecisionRows(
  tx: TenantTx, projectId: string, stage: Stage,
): Promise<DecisionVersionRow[]> {
  return [];
}
