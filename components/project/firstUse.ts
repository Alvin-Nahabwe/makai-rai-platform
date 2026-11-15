import type { StageCounts, StageReviewView } from '@/types/api';
import { STAGES, type Stage } from '@/types/record';

/**
 * Where S-10 first uses each defined term (spec 6, "a term is explained where it is first met"; plan 1A Task 9's rule,
 * lib/vocabulary/firstUse.ts), so its definition shows there and nowhere else on the page. Pure: it reads the same counts
 * and reviews the page renders, in the page's order (the stages in order, and in each stage its stops in order), and
 * names the one place each term's words first appear. The stage names are each defined under their own heading, always.
 */
export type FirstUses = {
  /** The stage whose open-findings line first says "finding". */
  finding: Stage | null;
  /** The first line of "Still open" that says "mitigation": the findings line's bracket, the Overdue line, or "No overdue mitigations". */
  mitigation: { stage: Stage; at: 'bracket' | 'overdue' | 'noOverdue' } | null;
  /** The stage whose "accepted risks, documents issued" line comes first. */
  acceptedRisk: Stage | null;
  /** "No stage review yet." or "Open a stage review" in a stage's Reviews stop, else the share line after the stages. */
  stageReview: { stage: Stage; at: 'empty' | 'open' } | 'share';
  /** A damaged seal's sentence ("Something in this seal has changed..."), else the share line ("seal a stage review"). */
  seal: { reviewId: string } | 'share';
};

/** Whether a stage's "Still open" holds a list (else it reads "Nothing is open in this stage."). */
export const hasOpenWork = (c: StageCounts): boolean => c.noDecision + c.openFindings + c.overdueMitigations + c.openMitigations > 0;

/** A review whose latest seal no longer holds together: its state line is the damaged sentence. */
export const sealDamaged = (r: StageReviewView): boolean => r.latestSeal !== null && (r.latestSealUnreadable || !r.latestSeal.bytesMatch);

export function firstUses(i: { counts: Readonly<Record<Stage, StageCounts>>; reviews: Readonly<Record<Stage, readonly StageReviewView[]>>; canOpenReview: boolean }): FirstUses {
  const out: FirstUses = { finding: null, mitigation: null, acceptedRisk: null, stageReview: 'share', seal: 'share' };
  let stageReviewFound = false;
  for (const stage of STAGES) {
    const c = i.counts[stage];
    if (hasOpenWork(c)) {
      if (out.finding === null && c.openFindings > 0) out.finding = stage;
      if (out.mitigation === null) {
        out.mitigation = c.openFindings > 0 && c.openFindingsWithoutMitigation > 0 ? { stage, at: 'bracket' }
          : { stage, at: c.overdueMitigations > 0 ? 'overdue' : 'noOverdue' };
      }
    }
    if (out.acceptedRisk === null && c.acceptedRisks + c.documentsIssued > 0) out.acceptedRisk = stage;
    const reviews = i.reviews[stage];
    if (out.seal === 'share') {
      const damaged = reviews.find(sealDamaged);
      if (damaged !== undefined) out.seal = { reviewId: damaged.id };
    }
    if (!stageReviewFound && (reviews.length === 0 || i.canOpenReview)) {
      out.stageReview = { stage, at: reviews.length === 0 ? 'empty' : 'open' };
      stageReviewFound = true;
    }
  }
  return out;
}
