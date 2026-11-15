import type { ReactElement, ReactNode } from 'react';
import type { StageReviewView } from '@/types/api';
import type { HomeBase, HomeData } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { TERM_CHANGED_SINCE_SEAL_N } from '@/lib/vocabulary/terms';
import { ListLink } from '@/components/ui/ListLink';
import { STAGE_NAME } from '@/components/project/StageColumn';
import { AssignedToYou } from '@/components/home/AssignedToYou';
import { FindingPlate } from '@/components/home/TeamLeadAdditions';
import type { FirstUses } from '@/components/home/firstUse';
import { Defs, MetaLine, StageName, TermHeading, TermList, projectNameIfMany } from '@/components/home/parts';

/** A review's name ("Pre-processing review 1"), its stage's words marked as a use of the stage's term. */
function reviewName(review: StageReviewView): ReactNode {
  const stage = STAGE_NAME[review.stage];
  if (!review.name.startsWith(stage)) return review.name;
  return <><StageName stage={review.stage} />{review.name.slice(stage.length)}</>;
}

/** A stage review as a plate: its name as the link to it, then (sealed and changed since) the vocabulary's "Changed since seal n", its stage and project. */
function ReviewPlate({ base, review, changed, uses }: { base: HomeBase; review: StageReviewView; changed: boolean; uses: FirstUses }): ReactElement {
  const project = projectNameIfMany(base, review.projectId);
  if (changed && review.latestSeal === null) throw new Error(`ReviewerHome: review ${review.id} is listed as changed since its seal but has none`);
  return (
    <li className="home-plate">
      <ListLink className="home-plate__title" href={`/orgs/${base.orgSlug}/projects/${review.projectId}/reviews/${review.id}`}>{reviewName(review)}</ListLink>
      <Defs uses={uses} where={`review:${review.id}`} />
      <MetaLine parts={[
        changed && review.latestSeal !== null ? TERM_CHANGED_SINCE_SEAL_N.term.replace('{n}', String(review.latestSeal.sealNumber)) : null,
        STAGE_NAME[review.stage],
        project === null ? null : <bdi>{project}</bdi>,
      ]} />
    </li>
  );
}

function Reviews({ base, heading, none, reviews, changed, uses, terms }: {
  base: HomeBase; heading: string; none: string; reviews: readonly StageReviewView[]; changed: boolean; uses: FirstUses; terms: string | null;
}): ReactElement {
  return (
    <section className="home-section">
      <h2>{heading}</h2>
      {terms === null ? null : <TermList uses={uses} where={terms} />}
      {reviews.length === 0 ? <p className="home-empty">{none}</p>
        : <ul className="home-plates" role="list">{reviews.map((r) => <ReviewPlate key={r.id} base={base} review={r} changed={changed} uses={uses} />)}</ul>}
    </section>
  );
}

/**
 * A Reviewer's Home (spec 9.1): the mitigations assigned to them when there are any (their own work; lane lead, fix
 * round 1), reviews not yet sealed, sealed reviews with changes since, and the findings they raised. Each review is the
 * newest of its stage (the loader). No next step and no recording link (T9.5). Each review list keeps its heading and
 * says when it is empty. Every defined term carries its definition at its first use (`uses`).
 */
export function ReviewerHome({ data, uses }: { data: Extract<HomeData, { variant: 'reviewer' }>; uses: FirstUses }): ReactElement {
  const { base } = data;
  return (
    <div className="home-columns">
      <div className="home-column">
        {data.assigned.length === 0 ? null : <AssignedToYou base={base} items={data.assigned} uses={uses} />}
        <Reviews base={base} heading={HOME_COPY.reviewerUnsealed} none={HOME_COPY.reviewerUnsealedNone} reviews={data.unsealed} changed={false} uses={uses} terms={null} />
        <Reviews base={base} heading={HOME_COPY.reviewerChanged} none={HOME_COPY.reviewerChangedNone} reviews={data.changedSinceSeal} changed uses={uses} terms="terms:changed" />
      </div>
      <div className="home-column">
        <section className="home-section">
          <TermHeading uses={uses} where="terms:raised" text={HOME_COPY.reviewerRaised} />
          {data.raisedByMe.length === 0 ? <p className="home-empty">{HOME_COPY.reviewerRaisedNone}</p>
            : <ul className="home-plates" role="list">{data.raisedByMe.map((f) => <FindingPlate key={f.id} base={base} finding={f} uses={uses} where={`raised:${f.id}`} />)}</ul>}
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
