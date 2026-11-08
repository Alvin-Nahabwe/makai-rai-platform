import type { Stage } from '@/types/record';
import type { StageReviewView } from '@/types/api';
import type { ReactElement } from 'react';
import { formatDay } from '@/lib/format/dates';
import { reviewStateLine } from './reviewText';
import { ReviewStateLine } from './DeviceTime';

export type StageReviewsSummaryProps = { orgSlug: string; projectId: string; stage: Stage; reviews: StageReviewView[]; canOpen: boolean };

/**
 * The stage reviews of one stage on S-10 (W-1 "Stage reviews"; FR-REV-01, FR-REV-05): each review's name, its note in
 * brackets, its state in words and "Open review"; "No stage review yet." for a stage with none (7.4.2 S-10, SRS line
 * 2379); "Open a stage review" only when `canOpen` (`can(role, 'review:open') && !archived`). Links are native `a`
 * elements. A slot of S-10: PRJ renders it, REV-b fills it.
 */
export function StageReviewsSummary({ orgSlug, projectId, stage, reviews, canOpen }: StageReviewsSummaryProps): ReactElement {
  const base = `/orgs/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectId)}/reviews`;
  return (
    <div className="stage-reviews">
      <h3>Stage reviews</h3>
      {reviews.length === 0 ? <p>No stage review yet.</p> : (
        <ul>
          {reviews.map((r) => {
            const note = r.preparedForErased !== null ? `(Prepared for: erased on ${formatDay(r.preparedForErased.erasedOn)})`
              : r.preparedFor !== null ? `(${r.preparedFor})` : null;
            return (
              <li key={r.id}>
                <p>{r.name}{note !== null ? ` ${note}` : ''}</p>
                <p><ReviewStateLine view={r} serverText={reviewStateLine(r)} /> <a href={`${base}/${encodeURIComponent(r.id)}`}>Open review</a></p>
              </li>
            );
          })}
        </ul>
      )}
      {canOpen ? <p><a href={`${base}/new?stage=${stage}`}>Open a stage review</a></p> : null}
    </div>
  );
}
