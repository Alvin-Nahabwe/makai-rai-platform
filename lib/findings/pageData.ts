import type { Identity } from '@/lib/auth/identity';
import { can } from '@/lib/authz/policy';
import { NotFoundError, withOrg, type OrgContext, type TenantTx } from '@/lib/data/tenant';
import { acceptedRisksToLookAgain, findingDetail, findingsToCloseByDecision, listFindings, mitigationHistory, mitigationOwnerCandidates } from '@/lib/data/findings';
import { ownerCannotAct } from '@/lib/data/followup';
import { contentRefById } from '@/lib/data/framework';
import { userRefs } from '@/lib/data/views';
import { loadContent, runningContent } from '@/lib/content/loader';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { groupFindings } from '@/lib/findings/groups';
import { decisionStatusWord, findingSourceLabel, findingStateLabel, STAGE_NAMES, stageCountHeading } from '@/lib/findings/labels';
import { eatDate, isOverdue } from '@/lib/followup/overdue';
import { STAGES, type CalendarDate, type FindingState, type OutsideRole, type Stage, type StoredDecisionStatus } from '@/types/record';
import type { AcceptedRiskView, FindingDetailView, FindingView, MitigationVersionView, UserRef } from '@/types/api';

/**
 * What S-14 and S-15 show, loaded once for the page (SRS 7.4.2 S-14 and S-15 rows, W-5, W-6). Each loader is one read path:
 * the project's name and `archivedAt` through `withOrg`, then FND-a's services, with `today = eatDate(new Date())`. A finding
 * of another project, a project of another organisation and a non-member all read as `NotFoundError` (NFR-SEC-02); this
 * module decides nothing about who may act beyond the `can` flags the views read, and every write is re-checked by its route.
 */

/** `?raise=1&stage=&questionId=&versionId=` (UX-14): the stage and question S-12 opened the raise form from. */
export interface RaisePrefill { stage: Stage; questionId: string | null; versionId: string | null }

/** The raise form's data: the stages, each stage's risk areas, and the prefill with the question's own areas listed first. */
export interface RaiseFormData {
  areas: Record<Stage, Array<{ id: string; name: string }>>;
  prefill: { stage: Stage; questionId: string; questionText: string; versionId: string | null; versionNumber: number | null; areaIds: string[] } | null;
}

/** One row of S-14: what a finding is called, where it came from and how it stands, as text. */
export interface FindingListItem {
  id: string; stage: Stage; title: string; sourceLabel: string; stateLabel: string; state: FindingState;
  /** Set for the two "close it" groups: why, and the decision version that closes it (route 11's body). */
  decisionVersionId: string | null; closeReason: 'decision_done' | 'decision_withdrawn' | 'gate_no' | null;
  openMitigations: number; overdueMitigations: number; raisedAt: string;
}

export interface StageGroupData {
  stage: Stage; name: string; heading: string; count: number;
  noMitigation: FindingListItem[]; overdue: FindingListItem[]; other: FindingListItem[];
}

export interface FindingsPageData {
  orgSlug: string; orgId: string; projectId: string; projectName: string; archived: boolean;
  userId: string; stageFilter: Stage | null; canRaise: boolean; canClose: boolean;
  /** The `shown` query value (UX-40): how many items of each list the person asked for, or null for the first page. */
  shown: string | null;
  /** True when the project has no finding at all (not when the filter hides them). */
  empty: boolean;
  decisionDone: FindingListItem[]; decisionWithdrawn: FindingListItem[]; stages: StageGroupData[];
  lookAgain: FindingListItem[]; closed: FindingListItem[]; withdrawn: FindingListItem[];
  raise: RaiseFormData | null;
}

interface VersionInfo { versionNumber: number; status: StoredDecisionStatus | null; contentSemver: string }

/** The decision versions the findings name, with the semver of the content each was answered against. */
async function versionsOf(tx: TenantTx, ids: readonly (string | null)[]): Promise<Map<string, VersionInfo>> {
  const wanted = [...new Set(ids.filter((i): i is string => i !== null))];
  const out = new Map<string, VersionInfo>();
  if (wanted.length === 0) return out;
  const rows = await tx.decisionVersion.findMany({ where: { id: { in: wanted } }, select: { id: true, versionNumber: true, status: true, contentVersionId: true } });
  const semvers = new Map<string, string>();
  for (const contentVersionId of new Set(rows.map((r) => r.contentVersionId))) {
    semvers.set(contentVersionId, (await contentRefById(tx, contentVersionId)).semver);
  }
  for (const r of rows) {
    out.set(r.id, { versionNumber: r.versionNumber, status: r.status as StoredDecisionStatus | null, contentSemver: semvers.get(r.contentVersionId) as string });
  }
  return out;
}

/** A question's text in the content version a decision was answered against, or in the running content; the id when the content lacks it. */
function questionTextOf(questionId: string, version: VersionInfo | undefined): string {
  const content = version === undefined ? runningContent() : loadContent(version.contentSemver as never);
  return content.questions.get(questionId)?.text ?? questionId;
}

/** A shortfall finding is called by the question's text in the content version it was raised against (it stores no title, 5.1). */
function titleOf(f: Pick<FindingView, 'source' | 'title' | 'questionId'>, version: VersionInfo | undefined): string {
  if (f.source === 'team') return f.title ?? FINDINGS_COPY.finding.untitled;
  if (f.questionId === null) return FINDINGS_COPY.finding.untitled;
  const text = version === undefined ? undefined : loadContent(version.contentSemver as never).questions.get(f.questionId)?.text;
  return text ?? f.questionId;
}

function itemOf(
  f: FindingView, version: VersionInfo | undefined, accepted: Pick<AcceptedRiskView, 'acceptedBy'> | null,
  closing: { decisionVersionId: string; reason: FindingListItem['closeReason'] } | undefined,
): FindingListItem {
  return {
    id: f.id, stage: f.stage, title: titleOf(f, version), state: f.state,
    decisionVersionId: closing?.decisionVersionId ?? null, closeReason: closing?.reason ?? null,
    sourceLabel: findingSourceLabel(f, version === undefined ? null : { versionNumber: version.versionNumber, status: version.status }),
    stateLabel: findingStateLabel(f.state, accepted), openMitigations: f.openMitigations, overdueMitigations: f.overdueMitigations, raisedAt: f.raisedAt,
  };
}

/** The current accepted risk of each finding (the highest findingSeq above its latest reopen, 5.3 item 11 rule 2) as the S-14 label needs it, in one read. */
async function currentAcceptedRisks(ctx: OrgContext, ids: readonly string[]): Promise<Map<string, Pick<AcceptedRiskView, 'acceptedBy'> | null>> {
  const out = new Map<string, Pick<AcceptedRiskView, 'acceptedBy'> | null>();
  if (ids.length === 0) return out;
  return withOrg(ctx, async (tx) => {
    const [risks, reopens] = await Promise.all([
      tx.acceptedRisk.findMany({ where: { findingId: { in: [...ids] } }, orderBy: { findingSeq: 'asc' } }),
      tx.findingEvent.findMany({ where: { findingId: { in: [...ids] }, kind: 'reopened' }, select: { findingId: true, findingSeq: true } }),
    ]);
    const reopenedAt = (id: string) => Math.max(0, ...reopens.filter((e) => e.findingId === id).map((e) => e.findingSeq));
    const refs = await userRefs(tx, risks.map((r) => r.acceptedByUserId).filter((u): u is string => u !== null));
    for (const id of ids) {
      const current = risks.filter((r) => r.findingId === id && r.findingSeq > reopenedAt(id)).at(-1);
      if (current === undefined) { out.set(id, null); continue; }
      const user = current.acceptedByUserId === null ? undefined : refs.get(current.acceptedByUserId);
      const by: AcceptedRiskView['acceptedBy'] | null = current.acceptedByRole !== null ? { kind: 'outside_role', role: current.acceptedByRole as OutsideRole } : user === undefined ? null : { kind: 'member', user };
      out.set(id, by === null ? null : { acceptedBy: by });
    }
    return out;
  });
}

async function projectOf(ctx: OrgContext, projectId: string): Promise<{ name: string; archived: boolean; orgSlug: string }> {
  return withOrg(ctx, async (tx) => {
    const [project, org] = await Promise.all([
      tx.project.findUnique({ where: { id: projectId }, select: { name: true, archivedAt: true } }),
      tx.organization.findUnique({ where: { id: ctx.orgId }, select: { slug: true } }),
    ]);
    if (project === null || org === null) throw new NotFoundError();
    return { name: project.name, archived: project.archivedAt !== null, orgSlug: org.slug };
  });
}

/** The raise form's areas by stage, and the prefill when S-12 sent one that names a real question of its stage (else none: a hand-made address shows a plain form). */
async function raiseFormData(ctx: OrgContext, projectId: string, raise: RaisePrefill | null): Promise<RaiseFormData> {
  const content = runningContent();
  const areas = Object.fromEntries(STAGES.map((s) => [s, [] as Array<{ id: string; name: string }>])) as RaiseFormData['areas'];
  for (const a of content.areas.values()) areas[a.stage].push({ id: a.id, name: a.name });
  const question = raise === null || raise.questionId === null ? undefined : content.questions.get(raise.questionId);
  if (raise === null || raise.questionId === null || question === undefined || question.stage !== raise.stage) return { areas, prefill: null };
  const version = raise.versionId === null ? null : await withOrg(ctx, (tx) => tx.decisionVersion.findFirst({
    where: { id: raise.versionId as string, projectId, questionId: question.id }, select: { id: true, versionNumber: true },
  }));
  return {
    areas,
    prefill: {
      stage: raise.stage, questionId: question.id, questionText: question.text, versionId: version?.id ?? null, versionNumber: version?.versionNumber ?? null,
      areaIds: question.gaps.filter((g) => content.areas.get(g)?.stage === raise.stage),
    },
  };
}

/**
 * S-14 (UX-15): the project's findings in UX-15's order. A stage filter keeps only that stage's findings in every group, and
 * each stage heading counts what is listed under it (UX-07). `canRaise` and `canClose` are the role's rights and an unarchived project.
 */
export async function loadFindingsPage(
  ctx: OrgContext, identity: Identity, a: { projectId: string; stage: Stage | null; raise: RaisePrefill | null; shown?: string | null },
): Promise<FindingsPageData> {
  const project = await projectOf(ctx, a.projectId);
  const today: CalendarDate = eatDate(new Date());
  const [all, toCloseAll, lookAgainAll] = await Promise.all([
    listFindings(ctx, a.projectId, a.stage ?? undefined, today),
    findingsToCloseByDecision(ctx, a.projectId),
    acceptedRisksToLookAgain(ctx, a.projectId, today),
  ]);
  const inScope = <T extends { stage: Stage }>(xs: readonly T[]) => (a.stage === null ? [...xs] : xs.filter((x) => x.stage === a.stage));
  // B2 (ruling R1): a finding with a mitigation Planned or In progress is blocked, so it is not offered for closing; it stays in its stage's group.
  const toClose = inScope(toCloseAll).filter((f) => f.openMitigations === 0);
  const lookAgain = inScope(lookAgainAll);
  const groups = groupFindings({ findings: all, toClose, lookAgain });

  const closing = new Map(toClose.map((f) => [f.id, { decisionVersionId: f.decisionVersionId, reason: f.reason }]));
  // A to-close entry's `decisionVersionId` is the version that closes it; the version that raised it is the list's.
  const raisedFrom = new Map(all.map((f) => [f.id, f.decisionVersionId]));
  const versions = await withOrg(ctx, (tx) => versionsOf(tx, all.map((f) => f.decisionVersionId)));
  // The accepter is in the finding's current accepted risk, not in its list view: one read for all the findings closed by one.
  const accepted = await currentAcceptedRisks(ctx, all.filter((f) => f.state === 'closed_accepted_risk').map((f) => f.id));
  const item = (f: FindingView) => itemOf(f, versions.get(raisedFrom.get(f.id) ?? ''), accepted.get(f.id) ?? null, closing.get(f.id));
  const items = (fs: readonly FindingView[]) => fs.map(item);

  const stages: StageGroupData[] = STAGES.map((stage) => {
    const g = groups.openByStage[stage];
    const count = g.noMitigation.length + g.overdue.length + g.other.length;
    return { stage, name: STAGE_NAMES[stage], heading: stageCountHeading(STAGE_NAMES[stage], count), count,
      noMitigation: items(g.noMitigation), overdue: items(g.overdue), other: items(g.other) };
  }).filter((g) => g.count > 0);

  const canRaise = can(ctx.role, 'finding:raise') && !project.archived;
  return {
    orgSlug: project.orgSlug, orgId: ctx.orgId, projectId: a.projectId, projectName: project.name, archived: project.archived,
    userId: identity.userId, stageFilter: a.stage, shown: a.shown ?? null, canRaise, canClose: can(ctx.role, 'mitigation:write') && !project.archived,
    empty: (a.stage === null ? all : await listFindings(ctx, a.projectId, undefined, today)).length === 0,
    decisionDone: items(groups.decisionDone), decisionWithdrawn: items(groups.decisionWithdrawn),
    stages, lookAgain: items(groups.lookAgain), closed: items(groups.closed), withdrawn: items(groups.withdrawn),
    raise: canRaise ? await raiseFormData(ctx, a.projectId, a.raise) : null,
  };
}

// ─── S-15 ────────────────────────────────────────────────────────────────────────────────────────

export interface MitigationOnPage {
  current: MitigationVersionView; versions: number; history: MitigationVersionView[]; overdue: boolean;
}

export interface FindingPageData {
  orgSlug: string; orgId: string; projectId: string; projectName: string; archived: boolean;
  viewer: { userId: string; name: string };
  detail: FindingDetailView;
  title: string; sourceLabel: string; stateLabel: string;
  /** A team finding about a question: that question's text (C#69), in the content version the named decision was answered against, else the running content. */
  questionText: string | null;
  /** Shortfall: the decision it was raised from. Team: the version it names, if any. */
  version: { versionNumber: number; status: StoredDecisionStatus | null; statusWord: string } | null;
  contentSemver: string;
  mitigations: MitigationOnPage[];
  /** The ids of this finding's mitigations whose owner cannot act (FUP's `ownerCannotAct`; `[]` until FUP merges). */
  ownerCannotAct: string[];
  owners: UserRef[];
  members: UserRef[];
  controls: Array<{ id: string; name: string }>;
  riskAreaName: string | null;
  /** W-5's "decision now done" box: the decision that closes this finding, with its question, number and status word. */
  closeByDecision: {
    reason: 'decision_done' | 'decision_withdrawn' | 'gate_no'; decisionVersionId: string;
    questionId: string; versionNumber: number; statusWord: string;
  } | null;
  /**
   * B2 (ruling R1): the close box shows, with no button, the sentence that the finding stays open while a mitigation is
   * Planned or In progress. True when the finding is blocked (`closeBlocked`) and the person could close it today.
   */
  closeBlocked: boolean;
  canMitigate: boolean; canAccept: boolean; canReopen: boolean; canWithdraw: boolean;
}

/**
 * B2 (ruling R1): an open finding is blocked when a current mitigation is planned or in progress and either a decision
 * closure is available or it already holds a closing record above R (a non-`action` mitigation with exactly one version,
 * whose `findingSeq` is above the latest reopen). Closing it would write a record and leave the finding open.
 */
function closeBlocked(detail: FindingDetailView, closureAvailable: boolean): boolean {
  if (detail.state !== 'open') return false;
  if (!detail.mitigations.some((m) => m.current.status === 'planned' || m.current.status === 'in_progress')) return false;
  const reopenedAt = Math.max(0, ...detail.events.filter((e) => e.kind === 'reopened').map((e) => e.findingSeq));
  return closureAvailable || detail.mitigations.some((m) => m.current.kind !== 'action' && m.versions === 1 && m.current.findingSeq > reopenedAt);
}

/** S-15: one finding of the route's project with its mitigations and history, or `NotFoundError`. */
export async function loadFindingPage(
  ctx: OrgContext, identity: Identity, a: { projectId: string; findingId: string },
): Promise<FindingPageData> {
  const project = await projectOf(ctx, a.projectId);
  const detail = await findingDetail(ctx, a.projectId, a.findingId);
  const [histories, owners, cannotAct, toClose] = await Promise.all([
    Promise.all(detail.mitigations.map((m) => mitigationHistory(ctx, a.projectId, m.mitigationId))),
    mitigationOwnerCandidates(ctx),
    ownerCannotAct(ctx, a.projectId),
    findingsToCloseByDecision(ctx, a.projectId),
  ]);
  const closing = toClose.find((f) => f.id === a.findingId);
  const { versions, members, viewer, closingVersion } = await withOrg(ctx, async (tx) => {
    const memberRows = await tx.membership.findMany({ where: { status: 'active' }, select: { userId: true } });
    const refs = await userRefs(tx, [...memberRows.map((m) => m.userId), identity.userId]);
    const self = refs.get(identity.userId);
    // The signed-in account has a user row (accounts are scrubbed, never deleted, FR-EXP-03); ids only in the message.
    if (self === undefined) throw new Error(`loadFindingPage: account ${identity.userId} has no user row`);
    return {
      versions: await versionsOf(tx, [detail.decisionVersionId]),
      closingVersion: closing === undefined ? null : await tx.decisionVersion.findUnique({
        where: { id: closing.decisionVersionId }, select: { questionId: true, versionNumber: true, status: true },
      }),
      members: memberRows.map((m) => refs.get(m.userId)).filter((r): r is UserRef => r !== undefined)
        .sort((x, y) => x.name.localeCompare(y.name) || x.userId.localeCompare(y.userId)),
      viewer: { userId: self.userId, name: self.name },
    };
  });
  const version = detail.decisionVersionId === null ? undefined : versions.get(detail.decisionVersionId);
  const content = runningContent();
  const cannot = new Set(cannotAct.filter((i) => i.findingId === a.findingId).map((i) => i.mitigationId));
  const today = eatDate(new Date());
  const raisedByMe = detail.raisedBy.userId === identity.userId;
  const writable = !project.archived;
  const mayClose = writable && can(ctx.role, 'mitigation:write');
  return {
    orgSlug: project.orgSlug, orgId: ctx.orgId, projectId: a.projectId, projectName: project.name, archived: project.archived, viewer, detail,
    title: titleOf(detail, version),
    questionText: detail.source === 'team' && detail.questionId !== null ? questionTextOf(detail.questionId, version) : null,
    sourceLabel: findingSourceLabel(detail, version === undefined ? null : { versionNumber: version.versionNumber, status: version.status }),
    stateLabel: findingStateLabel(detail.state, detail.acceptedRisk),
    version: version === undefined ? null : { versionNumber: version.versionNumber, status: version.status, statusWord: decisionStatusWord(version.status) },
    contentSemver: content.semver,
    mitigations: detail.mitigations.map((m, i) => ({
      current: m.current, versions: m.versions, history: histories[i],
      overdue: isOverdue(m.current, detail.state, today),
    })),
    ownerCannotAct: detail.mitigations.filter((m) => cannot.has(m.mitigationId)).map((m) => m.mitigationId),
    owners, members, controls: [...content.controls.values()].map((c) => ({ id: c.id, name: c.name })),
    riskAreaName: detail.riskArea === null ? null : content.areas.get(detail.riskArea)?.name ?? null,
    closeBlocked: mayClose && closeBlocked(detail, closing !== undefined),
    closeByDecision: closing === undefined || closingVersion === null || !mayClose ? null : {
      reason: closing.reason, decisionVersionId: closing.decisionVersionId, questionId: closingVersion.questionId,
      versionNumber: closingVersion.versionNumber, statusWord: decisionStatusWord(closingVersion.status as StoredDecisionStatus | null),
    },
    canMitigate: can(ctx.role, 'mitigation:write') && writable,
    canAccept: can(ctx.role, 'risk:accept') && writable,
    canReopen: can(ctx.role, 'finding:reopen') && writable,
    canWithdraw: detail.source === 'team' && detail.state !== 'withdrawn' && writable && can(ctx.role, 'finding:withdraw')
      && (ctx.role === 'owner' || ctx.role === 'admin' || raisedByMe),
  };
}
