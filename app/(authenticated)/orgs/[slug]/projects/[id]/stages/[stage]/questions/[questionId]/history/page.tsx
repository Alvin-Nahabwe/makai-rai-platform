import { notFound } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { requireOrgContextFor } from '@/lib/auth/context';
import { withOrg, type OrgContext } from '@/lib/data/tenant';
import { decisionHistory } from '@/lib/data/decisions';
import { sealsIncludingRows } from '@/lib/data/seals';
import { loadContent, runningContent } from '@/lib/content/loader';
import { canWithdrawVersion } from '@/lib/question/draft';
import { HISTORY_PAGE_SIZE, pageOf } from '@/lib/ui/showMore';
import { ArchivedBanner } from '@/components/project/ArchivedBanner';
import { DecisionHistoryList, type HistoryEntry } from '@/components/decision/DecisionHistoryList';
import { WithdrawDecision } from '@/components/decision/WithdrawDecision';
import { ShowMoreLink } from '@/components/ui/ShowMoreLink';
import { ListLink } from '@/components/ui/ListLink';
import { STAGES, type Stage } from '@/types/record';
import type { DecisionVersionView } from '@/types/api';
import type { OrgRole } from '@prisma/client';

export interface HistoryPageData {
  orgSlug: string; projectId: string; projectArchived: boolean; stage: Stage; questionId: string;
  viewer: { userId: string; role: OrgRole }; versions: DecisionVersionView[]; entries: HistoryEntry[];
}

/** The wording of a question in a content version, or null when that version is not listed or lacks the question. */
function wordingIn(semver: string, questionId: string): HistoryEntry['wording'] {
  try {
    const q = loadContent(semver).questions.get(questionId);
    return q === undefined ? null : { text: q.text, expectedPractice: q.expectedPractice };
  } catch {
    // A version the content index no longer lists (unknown_content_version): the entry still shows, without its wording.
    return null;
  }
}

/**
 * S-13's data (FR-DEC-04, FR-DEC-08, FR-CNT-07): the question's versions newest first, with each version's seals and
 * wording. The project is read inside `withOrg`, so another organisation's project is not found (NFR-SEC-02); a
 * question the running content does not hold in this stage is not found too.
 */
export async function loadHistoryPage(ctx: OrgContext, viewerId: string, p: { projectId: string; stage: Stage; questionId: string }): Promise<HistoryPageData | null> {
  const q = runningContent().questions.get(p.questionId);
  if (q === undefined || q.stage !== p.stage) return null;
  const project = await withOrg(ctx, (tx) => tx.project.findFirst({ where: { id: p.projectId }, select: { archivedAt: true, org: { select: { slug: true } } } }));
  if (project === null) return null;
  const versions = await decisionHistory(ctx, p.projectId, p.questionId);
  const seals = await sealsIncludingRows(ctx, versions.map((v) => v.id));
  return {
    orgSlug: project.org.slug, projectId: p.projectId, projectArchived: project.archivedAt !== null, stage: p.stage, questionId: p.questionId,
    viewer: { userId: viewerId, role: ctx.role }, versions,
    entries: versions.map((v) => ({ version: v, wording: wordingIn(v.content.semver, p.questionId), seals: seals.get(v.id) ?? [] })),
  };
}

/**
 * S-13, the decision history. Every member reads it (`record:read`); a role that cannot withdraw sees the page with
 * status 200 and no Withdraw control (owner question B21). The latest 20 versions show, then "Show older" (UX-40).
 */
export default async function HistoryPage({
  params, searchParams,
}: {
  params: Promise<{ slug: string; id: string; stage: string; questionId: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { slug, id, stage, questionId } = await params;
  const identity = await requireIdentity();
  const ctx = await requireOrgContextFor(identity.userId, slug, 'record:read');
  if (!(STAGES as readonly string[]).includes(stage)) notFound();
  const data = await loadHistoryPage(ctx, identity.userId, { projectId: id, stage: stage as Stage, questionId });
  if (data === null) notFound();
  const sp = await searchParams;
  return <HistoryView data={data} shown={typeof sp.shown === 'string' ? sp.shown : null} />;
}

/** The markup of S-13, exported so a test renders it from real data. */
export function HistoryView({ data, shown }: { data: HistoryPageData; shown: string | null }) {
  const page = pageOf(data.entries, shown, HISTORY_PAGE_SIZE);
  const current = data.versions[0] ?? null;
  const questionHref = `/orgs/${data.orgSlug}/projects/${data.projectId}/stages/${data.stage}/questions/${data.questionId}`;
  const n = data.versions.length;
  return (
    <div className="page-content">
      <ArchivedBanner archived={data.projectArchived} />
      <p><ListLink href={questionHref}>{`Back to ${data.questionId}`}</ListLink></p>
      <h1>{`History of ${data.questionId}`}</h1>
      <p>{n === 0 ? 'No decision has been recorded for this question yet.' : `${n} ${n === 1 ? 'version' : 'versions'}, newest first.`}</p>
      {current !== null ? (
        <WithdrawDecision
          orgSlug={data.orgSlug} projectId={data.projectId} stage={data.stage} questionId={data.questionId} current={current}
          canWithdraw={canWithdrawVersion(data.viewer.role, data.viewer.userId, current, data.projectArchived)}
        />
      ) : null}
      <DecisionHistoryList orgSlug={data.orgSlug} entries={page.items} />
      {page.hasMore ? <ShowMoreLink href={`?shown=${page.nextShown}`} label="Show older" /> : null}
    </div>
  );
}
