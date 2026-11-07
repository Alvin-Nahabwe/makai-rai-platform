import type { Prisma } from '@prisma/client';
import { assertCan, ForbiddenError, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import type {
  Actor, CalendarDate, DecisionVersionRow, DeclaredDate, DeclaredPrecision, FieldError, OutsideRole, ReasonCode, ScopeAnswer, Stage,
  StoredDecisionStatus, WithdrawalCode, WriteOutcome,
} from '@/types/record';
import type {
  ContentRef, DecisionVersionView, EvidenceItemView, SaveDecisionRequest, UserRef, WithdrawDecisionRequest,
} from '@/types/api';
import { ConflictError, ValidationFailed } from '@/lib/http/errors';
import { assertProjectWritable } from '@/lib/data/projectGuard';
import { assertEvidenceAttachable } from '@/lib/data/evidenceGuard';
import { erasedFields, evidenceViews, memberHistory, userRefs, userRefsFrom } from '@/lib/data/views';
import { lookupUserNames } from '@/lib/data/identity';
import { contentRefById, resolveRunningContentVersion } from '@/lib/data/framework';
import { idempotentWrite } from '@/lib/data/idempotency';
import { isUniqueViolation, uniqueViolationIndex } from '@/lib/data/pgErrors';
import { onShortfallSaved } from '@/lib/data/findings';
import { loadContent } from '@/lib/content/loader';
import { utcPlus14Date, validateDecisionFields } from '@/lib/decision/rules';
import { M11, REQUEST_MESSAGES } from '@/lib/decision/copy';
import { withdrawalFieldErrors } from '@/lib/decision/parse';
import { logSecurityEvent } from '@/lib/security-logger';

/**
 * Decision service (FR-DEC-01 to 05, 07 to 09): the decision record on the server. Every read and write runs
 * inside `withOrg`, so row-level security scopes it to the context's organisation; a project of another
 * organisation is not found (NFR-SEC-02). Versions are only ever inserted (FR-DEC-03; the append-only
 * triggers refuse an UPDATE or DELETE for every role). The current decision of a question is its highest
 * version, a withdrawal included (5.3 item 2).
 */

/** The unique index that numbers versions per (project, question): a concurrent duplicate fails on it (5.3 item 3). */
const VERSION_INDEX = 'decision_versions_orgId_projectId_questionId_versionNumber_key';

/** The order fields are reported in: the request's own order, so a summary lists them as the form does. */
const FIELD_ORDER = ['questionId', 'stage', 'status', 'scopeAnswer', 'optionsInPlace', 'reasonCode', 'reason', 'decidedBy', 'declaredDate', 'evidenceIds'];
const byField = (a: FieldError, b: FieldError) => FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field);

// ─── Rows and views ──────────────────────────────────────────────────────────────────────────────

/** The version's own columns: what an insert returns (its database-set received time and salt included). */
const COLUMN_SELECT = {
  id: true, orgId: true, projectId: true, stage: true, questionId: true, contentVersionId: true, versionNumber: true,
  baseVersionNumber: true, status: true, scopeAnswer: true, optionsInPlace: true, reasonCode: true, reason: true, reasonSalt: true,
  decidedByUserId: true, decidedByRole: true, declaredOn: true, declaredPrecision: true, withdrawalCode: true, enteredById: true,
  enteredByRole: true, receivedAt: true, requestId: true, requestDigest: true,
} satisfies Prisma.DecisionVersionSelect;

const ROW_SELECT = { ...COLUMN_SELECT, evidence: { select: { evidenceId: true } } } satisfies Prisma.DecisionVersionSelect;

type SelectedRow = Prisma.DecisionVersionGetPayload<{ select: typeof ROW_SELECT }>;
type SelectedColumns = Prisma.DecisionVersionGetPayload<{ select: typeof COLUMN_SELECT }>;
/** A version's own columns, typed as a row: everything but its evidence. */
type VersionColumns = Omit<DecisionVersionRow, 'evidenceIds'>;

function toColumns(r: SelectedColumns): VersionColumns {
  return {
    ...r,
    stage: r.stage as Stage, status: r.status as StoredDecisionStatus | null, scopeAnswer: r.scopeAnswer as ScopeAnswer | null,
    decidedByRole: r.decidedByRole as OutsideRole | null, declaredPrecision: r.declaredPrecision as DeclaredPrecision | null,
    withdrawalCode: r.withdrawalCode as WithdrawalCode | null,
  };
}

function toRow(r: SelectedRow): DecisionVersionRow {
  const { evidence, ...rest } = r;
  return { ...toColumns(rest), evidenceIds: evidence.map((e) => e.evidenceId).sort() };
}

async function rowsWhere(tx: TenantTx, where: { id?: { in: string[] }; projectId?: string; questionId?: string }, newestFirst = false): Promise<DecisionVersionRow[]> {
  const rows = await tx.decisionVersion.findMany({
    where, select: ROW_SELECT,
    orderBy: newestFirst ? [{ versionNumber: 'desc' }] : [{ questionId: 'asc' }, { versionNumber: 'asc' }],
  });
  return rows.map(toRow);
}

/**
 * The highest version's own columns, without its evidence, or null when it has none: what a save needs to judge its base
 * and, unless every other field repeats, whether it repeats the version (`withEvidence` completes it when it must).
 */
async function currentColumns(tx: TenantTx, projectId: string, questionId: string): Promise<VersionColumns | null> {
  const row = await tx.decisionVersion.findFirst({ where: { projectId, questionId }, select: COLUMN_SELECT, orderBy: { versionNumber: 'desc' } });
  return row === null ? null : toColumns(row);
}

/** The full row of `columns`: its evidence read in the same transaction. */
async function withEvidence(tx: TenantTx, columns: VersionColumns): Promise<DecisionVersionRow> {
  const evidence = await tx.decisionEvidence.findMany({ where: { versionId: columns.id }, select: { evidenceId: true } });
  return { ...columns, evidenceIds: evidence.map((e) => e.evidenceId).sort() };
}

/** The highest version of (project, question), or null when it has none (5.3 item 2). */
async function currentRow(tx: TenantTx, projectId: string, questionId: string): Promise<DecisionVersionRow | null> {
  const row = await tx.decisionVersion.findFirst({ where: { projectId, questionId }, select: ROW_SELECT, orderBy: { versionNumber: 'desc' } });
  return row === null ? null : toRow(row);
}

/** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' from the stored calendar date and its precision (W-3 note 7, SRS line 1909). */
function declaredDateOf(on: Date | null, precision: DeclaredPrecision | null): DeclaredDate | null {
  if (on === null || precision === null) return null;
  const day = on.toISOString().slice(0, 10);
  return precision === 'year' ? day.slice(0, 4) : precision === 'month' ? day.slice(0, 7) : day;
}

/** The stored calendar date and precision of a declared date: a month or a year is kept as its first day. */
function declaredColumns(d: DeclaredDate): { declaredOn: Date; declaredPrecision: DeclaredPrecision } {
  const declaredPrecision: DeclaredPrecision = d.length === 4 ? 'year' : d.length === 7 ? 'month' : 'day';
  const first = declaredPrecision === 'year' ? `${d}-01-01` : declaredPrecision === 'month' ? `${d}-01` : d;
  return { declaredOn: new Date(`${first}T00:00:00.000Z`), declaredPrecision };
}

/**
 * The one view builder every read uses: names with the former-member mark (`userRefs`), evidence with its
 * erased mark (`evidenceViews`), the reason's erased mark (`erasedFields`), and each version's own content
 * version (FR-CNT-07), all read in the caller's transaction.
 */
async function toView(tx: TenantTx, rows: readonly DecisionVersionRow[]): Promise<DecisionVersionView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const people = rows.flatMap((r) => (r.decidedByUserId ? [r.enteredById, r.decidedByUserId] : [r.enteredById]));
  const contentIds = [...new Set(rows.map((r) => r.contentVersionId))];
  const [refs, evidence, erased, contents] = await Promise.all([
    userRefs(tx, people),
    evidenceViews(tx, rows.flatMap((r) => r.evidenceIds)),
    erasedFields(tx, 'decision_versions', ids),
    Promise.all(contentIds.map(async (id) => [id, await contentRefById(tx, id)] as const)),
  ]);
  const content = new Map<string, ContentRef>(contents);
  return rows.map((r) => assembleView(r, { refs, evidence, erased: erased.get(r.id), content: content.get(r.contentVersionId) as ContentRef }));
}

/**
 * The view of a version this transaction has just inserted, from what the save already holds: its row as the insert
 * returned it, the content version it resolved and stores, and the member history it read for the decider check
 * (`memberHistory`; `userRefsFrom` sets the former-member mark from it, as `userRefs` does). Equal to `toView` of the
 * same row (save-statements.test.ts), without its second reads: no erasure mark can name a row created in this
 * transaction (a tombstone names a committed row), and the content version is the one just resolved. A person the
 * history does not cover is read here, as `userRefs` would.
 */
async function savedView(
  tx: TenantTx, row: DecisionVersionRow, content: ContentRef, history: ReadonlyMap<string, 'member' | 'former' | 'never'>,
): Promise<DecisionVersionView> {
  const people = [...new Set(row.decidedByUserId ? [row.enteredById, row.decidedByUserId] : [row.enteredById])];
  const known = people.every((id) => history.has(id)) ? history : await memberHistory(tx, people);
  const [names, evidence] = await Promise.all([lookupUserNames(people), evidenceViews(tx, row.evidenceIds)]);
  return assembleView(row, { refs: userRefsFrom(people, known, names), evidence, erased: undefined, content });
}

/** The one view of one version, from what `toView` or `savedView` read for it. */
function assembleView(r: DecisionVersionRow, parts: {
  refs: ReadonlyMap<string, UserRef>; evidence: ReadonlyMap<string, EvidenceItemView>;
  erased: { fields: string[]; erasedOn: CalendarDate } | undefined; content: ContentRef;
}): DecisionVersionView {
  const { refs, evidence, erased: e, content } = parts;
  // Integrity faults, never a user's: ids only in the message (NFR-PRIV-03), so the row can be found.
  const person = (id: string) => {
    const ref = refs.get(id);
    // Accounts are scrubbed, never deleted (FR-EXP-03), so a record never names an id with no account row.
    if (ref === undefined) throw new Error(`decision view: version ${r.id} names user ${id}, which has no account row`);
    return ref;
  };
  const item = (id: string) => {
    const v = evidence.get(id);
    // decision_evidence holds a foreign key to evidence, whose rows are never deleted (5.3 item 8).
    if (v === undefined) throw new Error(`decision view: version ${r.id} attaches evidence ${id}, which has no evidence row`);
    return v;
  };
  return {
    id: r.id, projectId: r.projectId, stage: r.stage, questionId: r.questionId, versionNumber: r.versionNumber,
    baseVersionNumber: r.baseVersionNumber, content, status: r.status,
    scopeAnswer: r.scopeAnswer, optionsInPlace: [...r.optionsInPlace], reasonCode: r.reasonCode as ReasonCode | null, reason: r.reason,
    reasonErased: e !== undefined && e.fields.includes('reason') ? { erasedOn: e.erasedOn } : null,
    decidedBy: r.decidedByUserId !== null ? { kind: 'member', user: person(r.decidedByUserId) }
      : r.decidedByRole !== null ? { kind: 'outside_role', role: r.decidedByRole } : null,
    declaredDate: declaredDateOf(r.declaredOn, r.declaredPrecision), declaredPrecision: r.declaredPrecision,
    withdrawalCode: r.withdrawalCode, enteredBy: person(r.enteredById), enteredByRole: r.enteredByRole,
    receivedAt: r.receivedAt.toISOString(),
    evidence: r.evidenceIds.map((id) => item(id)).sort((x, y) => x.uploadedAt.localeCompare(y.uploadedAt) || x.id.localeCompare(y.id)),
  };
}

/** The one element of a result that must hold exactly one: a row just inserted or found in the same transaction. */
function one<T>(xs: readonly T[], what: string): T {
  if (xs.length !== 1) throw new Error(`decisions: expected exactly one ${what}, got ${xs.length}`);
  return xs[0];
}

async function viewOf(tx: TenantTx, row: DecisionVersionRow | null): Promise<DecisionVersionView | null> {
  return row === null ? null : one(await toView(tx, [row]), 'view of the current version');
}

/** The view of one stored version, by id. */
async function viewById(tx: TenantTx, id: string): Promise<DecisionVersionView> {
  return one(await toView(tx, await rowsWhere(tx, { id: { in: [id] } })), `decision version ${id}`);
}

// ─── Saving ──────────────────────────────────────────────────────────────────────────────────────

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
async function checkSave(
  tx: TenantTx, a: SaveDecisionRequest & { projectId: string }, actorUserId: string,
): Promise<{ content: ContentRef; history: ReadonlyMap<string, 'member' | 'former' | 'never'> }> {
  const content = await resolveRunningContentVersion(tx);
  const loaded = loadContent(content.semver);
  const question = loaded.questions.get(a.questionId);
  const errors: FieldError[] = [];
  if (question === undefined) {
    errors.push({ field: 'questionId', message: REQUEST_MESSAGES.questionId });
  } else {
    if (question.stage !== a.stage) errors.push({ field: 'stage', message: REQUEST_MESSAGES.stage });
    // A checklist with no options is a content defect, not the person's mistake: refuse it as the server's.
    if (question.type === 'checklist' && question.options === undefined) {
      throw new Error(`content ${content.semver}: checklist question ${question.id} has no options`);
    }
    errors.push(...validateDecisionFields({
      questionType: question.type, options: question.options ?? [], reasonCodes: loaded.reasonCodes,
      status: a.status, scopeAnswer: a.scopeAnswer, optionsInPlace: a.optionsInPlace, reasonCode: a.reasonCode, reason: a.reason,
      decidedBy: a.decidedBy, declaredDate: a.declaredDate,
    }, utcPlus14Date(await dbNow(tx))));
  }
  // The entering account's history is read with the decider's, so the saved version's view needs no second read.
  let history: ReadonlyMap<string, 'member' | 'former' | 'never'> = new Map();
  if (a.decidedBy.kind === 'member' && !errors.some((e) => e.field === 'decidedBy')) {
    history = await memberHistory(tx, [a.decidedBy.userId, actorUserId]);
    if (history.get(a.decidedBy.userId) === 'never') errors.push({ field: 'decidedBy', message: M11.decidedBy });
  }
  if (new Set(a.evidenceIds).size !== a.evidenceIds.length) {
    errors.push({ field: 'evidenceIds', message: REQUEST_MESSAGES.evidenceIds });
  } else {
    try {
      await assertEvidenceAttachable(tx, a.projectId, a.evidenceIds);
    } catch (e) {
      // Only the guard's own refusal is merged, so its field joins the others in one answer; anything else, and a
      // refusal that names no field (which would otherwise merge as no error and attach what the guard refused), propagates.
      const fields = e instanceof ValidationFailed ? e.extra?.fields : undefined;
      if (fields === undefined || fields.length === 0) throw e;
      errors.push(...fields);
    }
  }
  if (errors.length > 0) throw new ValidationFailed(errors.sort(byField));
  return { content, history };
}

const sameSet = (x: readonly string[], y: readonly string[]) => x.length === y.length && [...x].sort().join('\u0000') === [...y].sort().join('\u0000');

/**
 * FR-DEC-01: the save repeats version `cur` in every field, the declared date and the content version included. The
 * evidence is compared last, and read only then: a save that differs in any other field never needs it.
 */
async function repeats(tx: TenantTx, cur: VersionColumns, a: SaveDecisionRequest, contentVersionId: string): Promise<boolean> {
  const decider = a.decidedBy.kind === 'member' ? { user: a.decidedBy.userId, role: null } : { user: null, role: a.decidedBy.role };
  const othersRepeat = cur.status === a.status && cur.scopeAnswer === a.scopeAnswer && sameSet(cur.optionsInPlace, a.optionsInPlace)
    && cur.reasonCode === a.reasonCode && cur.reason === a.reason
    && cur.decidedByUserId === decider.user && cur.decidedByRole === decider.role
    && declaredDateOf(cur.declaredOn, cur.declaredPrecision) === a.declaredDate
    && cur.contentVersionId === contentVersionId;
  return othersRepeat && sameSet((await withEvidence(tx, cur)).evidenceIds, a.evidenceIds);
}

/**
 * FR-DEC-01 to 03, 05, 07, 09: one save, retry-safe by request id and digest (`idempotentWrite`, 5.3 item 4).
 * Inside one transaction: the project is writable, the save is valid (`checkSave`), its base is the current
 * version (else 409 `base_version_moved` with that version), it does not repeat the current version, and the
 * new version is inserted with the number after the current one, entered by the session's account and role
 * (the received time is the database's, set by its insert trigger), with its evidence and the shortfall rule
 * of FND-a (`onShortfallSaved`). A concurrent save that took the same number fails on the unique index, and is
 * answered, after reading the current version anew, as the conflict it is (5.3 items 3 and 4).
 */
export async function saveDecision(
  ctx: OrgContext, actor: Actor, a: SaveDecisionRequest & { projectId: string }, digest: string,
): Promise<WriteOutcome<DecisionVersionView>> {
  assertCan(ctx, 'decision:write');
  // The finding the attempt's onShortfallSaved returned; read only when the outcome is a write, not a replay.
  let finding: { findingId: string } | null = null;
  const outcome = await writeVersion(ctx, a, {
    requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      const { content, history } = await checkSave(tx, a, actor.userId);
      const current = await currentColumns(tx, a.projectId, a.questionId);
      // No version yet: a named base is a hand-made or stale request, refused on its field as the withdrawal does.
      if (current === null && a.baseVersionNumber !== null) {
        throw new ValidationFailed([{ field: 'baseVersionNumber', message: REQUEST_MESSAGES.baseVersionNumber }]);
      }
      if (current !== null && a.baseVersionNumber !== current.versionNumber) {
        throw new ConflictError('base_version_moved', await viewOf(tx, await withEvidence(tx, current)));
      }
      if (current !== null && current.status !== 'withdrawn' && await repeats(tx, current, a, content.contentVersionId)) {
        throw new ValidationFailed([{ field: 'form', message: M11.unchanged(current.versionNumber) }]);
      }
      const created = await tx.decisionVersion.create({
        data: {
          orgId: ctx.orgId, projectId: a.projectId, stage: a.stage, questionId: a.questionId,
          contentVersionId: content.contentVersionId, versionNumber: (current?.versionNumber ?? 0) + 1,
          baseVersionNumber: a.baseVersionNumber, status: a.status, scopeAnswer: a.scopeAnswer, optionsInPlace: a.optionsInPlace,
          reasonCode: a.reasonCode, reason: a.reason,
          decidedByUserId: a.decidedBy.kind === 'member' ? a.decidedBy.userId : null,
          decidedByRole: a.decidedBy.kind === 'outside_role' ? a.decidedBy.role : null,
          ...declaredColumns(a.declaredDate),
          enteredById: actor.userId, enteredByRole: actor.role, requestId: a.requestId, requestDigest: digest,
        },
        select: COLUMN_SELECT,
      });
      if (a.evidenceIds.length > 0) {
        await tx.decisionEvidence.createMany({ data: a.evidenceIds.map((evidenceId) => ({ orgId: ctx.orgId, versionId: created.id, evidenceId })) });
      }
      // The row as the insert returned it (the received time and salt the database set included), with the evidence
      // just attached: what reading it back would give, without the read.
      const row = toRow({ ...created, evidence: a.evidenceIds.map((evidenceId) => ({ evidenceId })) });
      finding = await onShortfallSaved(tx, ctx, {
        id: row.id, projectId: row.projectId, stage: row.stage, questionId: row.questionId, status: row.status, enteredById: row.enteredById,
      }, { requestId: a.requestId, digest });
      return savedView(tx, row, content, history);
    },
  });
  if (!outcome.replayed) {
    logVersion('DECISION_SAVED', ctx, actor, outcome.value);
    // Assigned inside the write callback, which TypeScript's narrowing does not follow, so the type is restated.
    const raised = finding as { findingId: string } | null;
    if (raised !== null) {
      logSecurityEvent('FINDING_RAISED', 'info', {
        userId: actor.userId, details: { orgId: ctx.orgId, projectId: a.projectId, findingId: raised.findingId, source: 'shortfall' },
      });
    }
  }
  return outcome;
}

/**
 * NFR-OBS-01: one line per action, after its transaction has committed (`idempotentWrite` resolves after the
 * commit), never for a replay, holding ids only (NFR-PRIV-03; contract "Security event names").
 */
function logVersion(event: 'DECISION_SAVED' | 'DECISION_WITHDRAWN', ctx: OrgContext, actor: Actor, v: DecisionVersionView): void {
  logSecurityEvent(event, 'info', {
    userId: actor.userId, details: { orgId: ctx.orgId, projectId: v.projectId, versionId: v.id, versionNumber: v.versionNumber },
  });
}

/**
 * `idempotentWrite` of one decision version of (project, question), replayed as the stored version's view. It rethrows a
 * failed attempt's own error only when no row holds this request id, so a violation of the numbering index that reaches
 * here is another write that took the number first: a real conflict, answered 409 with the current version (5.3 item 3).
 */
async function writeVersion(
  ctx: OrgContext, at: { projectId: string; questionId: string },
  a: { requestId: string; digest: string; actorUserId: string; write: (tx: TenantTx) => Promise<DecisionVersionView> },
): Promise<WriteOutcome<DecisionVersionView>> {
  try {
    return await idempotentWrite(ctx, {
      table: 'decision_versions', requestId: a.requestId, digest: a.digest, actorUserId: a.actorUserId, write: a.write, replay: viewById,
    });
  } catch (e) {
    if (isUniqueViolation(e) && uniqueViolationIndex(e) === VERSION_INDEX) throw await versionMoved(ctx, at.projectId, at.questionId);
    throw e;
  }
}

/** The 409 for a base that is not the current version, carrying the current version read anew (5.3 item 4). */
async function versionMoved(ctx: OrgContext, projectId: string, questionId: string): Promise<ConflictError> {
  return new ConflictError('base_version_moved', await withOrg(ctx, async (tx) => viewOf(tx, await currentRow(tx, projectId, questionId))));
}

/**
 * FR-DEC-08: a withdrawal is a new version with status 'withdrawn', its withdrawal code and reason, no decider,
 * date or options, and the content version running now; the question then has no decision (5.3 item 2). Its
 * base must be the current version (else 409 `base_version_moved`); a question with no current decision, or
 * whose current version is itself a withdrawal, has nothing to withdraw (422). The object rule (obligation D3)
 * is judged on the current version read in the same transaction as the insert: an assessor may withdraw only
 * a version they entered; an owner or admin any. A withdrawal raises no finding, so `onShortfallSaved` is not
 * called; FND-a's S-14 list finds an open finding whose decision was withdrawn.
 */
export async function withdrawDecision(
  ctx: OrgContext, actor: Actor, a: WithdrawDecisionRequest & { projectId: string; questionId: string }, digest: string,
): Promise<WriteOutcome<DecisionVersionView>> {
  assertCan(ctx, 'decision:withdraw');
  const fields = withdrawalFieldErrors(a);
  if (fields.length > 0) throw new ValidationFailed(fields);
  const outcome = await writeVersion(ctx, a, {
    requestId: a.requestId, digest, actorUserId: actor.userId,
    write: async (tx) => {
      await assertProjectWritable(tx, a.projectId);
      const content = await resolveRunningContentVersion(tx);
      const current = await currentRow(tx, a.projectId, a.questionId);
      if (current === null) throw new ValidationFailed([{ field: 'baseVersionNumber', message: REQUEST_MESSAGES.noCurrentDecision }]);
      if (a.baseVersionNumber !== current.versionNumber) throw new ConflictError('base_version_moved', await viewOf(tx, current));
      if (current.status === 'withdrawn') throw new ValidationFailed([{ field: 'baseVersionNumber', message: REQUEST_MESSAGES.noCurrentDecision }]);
      if (current.stage !== a.stage) throw new ValidationFailed([{ field: 'stage', message: REQUEST_MESSAGES.stage }]);
      if (actor.role !== 'owner' && actor.role !== 'admin' && current.enteredById !== actor.userId) {
        throw new ForbiddenError('decision:withdraw', actor.role);
      }
      const created = await tx.decisionVersion.create({
        data: {
          orgId: ctx.orgId, projectId: a.projectId, stage: current.stage, questionId: a.questionId,
          contentVersionId: content.contentVersionId, versionNumber: current.versionNumber + 1, baseVersionNumber: current.versionNumber,
          status: 'withdrawn', scopeAnswer: null, optionsInPlace: [], reasonCode: null, reason: a.reason,
          decidedByUserId: null, decidedByRole: null, declaredOn: null, declaredPrecision: null, withdrawalCode: a.withdrawalCode,
          enteredById: actor.userId, enteredByRole: actor.role, requestId: a.requestId, requestDigest: digest,
        },
        select: { id: true },
      });
      return viewById(tx, created.id);
    },
  });
  if (!outcome.replayed) logVersion('DECISION_WITHDRAWN', ctx, actor, outcome.value);
  return outcome;
}

// ─── Reads ───────────────────────────────────────────────────────────────────────────────────────

/** Key: question id. A withdrawal is a current version. */
export async function currentDecisions(
  ctx: OrgContext, projectId: string, stage: Stage,
): Promise<Map<string, DecisionVersionView>> {
  return withOrg(ctx, async (tx) => {
    const views = await toView(tx, await currentDecisionRows(tx, projectId, stage));
    return new Map(views.map((v) => [v.questionId, v]));
  });
}

/** Every version of the question, newest first (FR-DEC-04, S-13). */
export async function decisionHistory(
  ctx: OrgContext, projectId: string, questionId: string,
): Promise<DecisionVersionView[]> {
  return withOrg(ctx, async (tx) => toView(tx, await rowsWhere(tx, { projectId, questionId }, true)));
}

/**
 * The current version of each question of the project whose current version is in `stage`, in question id order; a
 * withdrawal is a current version. Picked over all the project's versions before the stage is compared, so an older
 * version in another stage can never stand in for a question's current one.
 */
export async function currentDecisionRows(
  tx: TenantTx, projectId: string, stage: Stage,
): Promise<DecisionVersionRow[]> {
  const ids = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM (
      SELECT DISTINCT ON ("questionId") "id", "stage" FROM "decision_versions"
      WHERE "projectId" = ${projectId} ORDER BY "questionId", "versionNumber" DESC
    ) AS cur WHERE cur."stage" = ${stage}`;
  return ids.length === 0 ? [] : rowsWhere(tx, { id: { in: ids.map((r) => r.id) } });
}
