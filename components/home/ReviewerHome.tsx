import type { ReactElement } from 'react';
import type { StageReviewView } from '@/types/api';
import type { HomeBase, HomeData } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { TERM_CHANGED_SINCE_SEAL_N, TERM_FINDING, TERM_SEAL } from '@/lib/vocabulary/terms';
import { ListLink } from '@/components/ui/ListLink';
import { STAGE_NAME } from '@/components/project/StageColumn';
import { TermList } from '@/components/home/AssignedToYou';
import { FindingPlate } from '@/components/home/TeamLeadAdditions';
import { MetaLine, projectNameIfMany } from '@/components/home/parts';

/** A stage review as a plate: its name as the link to it, then (sealed and changed since) the vocabulary's "Changed since seal n", its stage and project. */
function ReviewPlate({ base, review, changed }: { base: HomeBase; review: StageReviewView; changed: boolean }): ReactElement {
  const project = projectNameIfMany(base, review.projectId);
  if (changed && review.latestSeal === null) throw new Error(`ReviewerHome: review ${review.id} is listed as changed since its seal but has none`);
  return (
    <li className="home-plate">
      <ListLink className="home-plate__title" href={`/orgs/${base.orgSlug}/projects/${review.projectId}/reviews/${review.id}`}>{review.name}</ListLink>
      <MetaLine parts={[
        changed && review.latestSeal !== null ? TERM_CHANGED_SINCE_SEAL_N.term.replace('{n}', String(review.latestSeal.sealNumber)) : null,
        STAGE_NAME[review.stage],
        project === null ? null : <bdi>{project}</bdi>,
      ]} />
    </li>
  );
}

function Reviews({ base, heading, none, reviews, changed }: {
  base: HomeBase; heading: string; none: string; reviews: readonly StageReviewView[]; changed: boolean;
}): ReactElement {
  return (
    <section className="home-section">
      <h2>{heading}</h2>
      {reviews.length === 0 ? <p className="home-empty">{none}</p>
        : <ul className="home-plates" role="list">{reviews.map((r) => <ReviewPlate key={r.id} base={base} review={r} changed={changed} />)}</ul>}
    </section>
  );
}

/**
 * A Reviewer's Home (spec 9.1): reviews not yet sealed, sealed reviews with changes since, and the findings they raised.
 * No next step and no recording link (T9.5). Each list keeps its heading and says when it is empty, so a Reviewer learns
 * where each kind of work will appear. "Seal" and "finding" carry their definitions at their first use.
 */
export function ReviewerHome({ data }: { data: Extract<HomeData, { variant: 'reviewer' }> }): ReactElement {
  const { base } = data;
  return (
    <div className="home-columns">
      <div className="home-column">
        <Reviews base={base} heading={HOME_COPY.reviewerUnsealed} none={HOME_COPY.reviewerUnsealedNone} reviews={data.unsealed} changed={false} />
        <section className="home-section">
          <h2>{HOME_COPY.reviewerChanged}</h2>
          <TermList terms={[{ entry: TERM_SEAL, word: 'Seal' }]} />
          {data.changedSinceSeal.length === 0 ? <p className="home-empty">{HOME_COPY.reviewerChangedNone}</p>
            : <ul className="home-plates" role="list">{data.changedSinceSeal.map((r) => <ReviewPlate key={r.id} base={base} review={r} changed />)}</ul>}
        </section>
      </div>
      <div className="home-column">
        <section className="home-section">
          <h2>{HOME_COPY.reviewerRaised}</h2>
          <TermList terms={[{ entry: TERM_FINDING, word: 'Finding' }]} />
          {data.raisedByMe.length === 0 ? <p className="home-empty">{HOME_COPY.reviewerRaisedNone}</p>
            : <ul className="home-plates" role="list">{data.raisedByMe.map((f) => <FindingPlate key={f.id} base={base} finding={f} />)}</ul>}
        </section>
        <AllProjects orgSlug={base.orgSlug} others={null} />
      </div>
    </div>
  );
}

/** The way to every project: "You have N other projects." when the reader has a focus project and others, then All projects. */
export function AllProjects({ orgSlug, others }: { orgSlug: string; others: number | null }): ReactElement {
  return (
    <div className="home-more">
      {others !== null && others > 0 ? <p>{HOME_COPY.otherProjects(others)}</p> : null}
      <ListLink href={`/orgs/${orgSlug}/projects`}>{HOME_COPY.allProjects}</ListLink>
    </div>
  );
}
