export const STAGE_ORDER = ['pre-processing', 'in-processing', 'post-processing'] as const;
export type StageName = typeof STAGE_ORDER[number];

export interface StageConfig {
  label: string;
  color: string;
  shortKey: string;
}

export const stageLabels: Record<StageName, StageConfig> = {
  'pre-processing': { label: 'Pre-processing', color: '#C06014', shortKey: 'pre' },
  'in-processing': { label: 'In-processing', color: '#8B4513', shortKey: 'in' },
  'post-processing': { label: 'Post-processing', color: '#A0522D', shortKey: 'post' },
};

export const stageColors: Record<StageName, string> = {
  'pre-processing': '#C06014',
  'in-processing': '#8B4513',
  'post-processing': '#A0522D',
};

// `notAssessed` (getLevel's fifth band, Plan 2 Task 4): reached when
// EvidenceScore.maturity is null -- the framework has no maturity question
// for this area/principle at all, not that a question went unanswered.
// Label and description are worded accordingly: "nothing to answer", never
// "nothing was answered" -- the latter would tell a diligent team it skipped
// work it was never asked to do. The color (gray) deliberately sits off the
// red/orange/yellow/green severity spectrum the other four levels use, so
// this reads as "not applicable" rather than as a fifth, worse score --
// consistent with the neutral gray components/report/AreaCard.tsx already
// uses for its own 'not-assessed' tier.
export const levelLabels: Record<string, string> = {
  critical: 'Critical',
  needsWork: 'Needs Work',
  developing: 'Developing',
  strong: 'Strong',
  notAssessed: 'Not Assessed',
};

export const levelColors: Record<string, string> = {
  critical: '#DC2626',
  needsWork: '#F97316',
  developing: '#FACC15',
  strong: '#22C55E',
  notAssessed: '#6B7280',
};

export const levelDescriptions: Record<string, string> = {
  critical: 'Significant gaps that need immediate attention',
  needsWork: 'Notable areas requiring focused improvement',
  developing: 'Progress evident with room for further development',
  strong: 'Comprehensive practices demonstrating maturity',
  notAssessed: 'This area has no maturity question in the current framework — there was nothing to answer',
};

/**
 * Rendered instead of a band word wherever `lib/report/maturityBands.ts#
 * labelIsShowable` is false for the report/assessment a surface is
 * displaying (maturity-band-reanchor Task 7). Not a sixth band: it carries
 * no entry in `levelColors`/`levelRange`/`levelDescriptions`, because it is
 * not a point on the 0-100% scale those describe -- it is a statement that
 * THIS report's numbers cannot be honestly classified under the CURRENT
 * band vocabulary at all, band-independent. Its colour is
 * `--color-verdict-withheld` (app/globals.css), never a `levelColors`
 * lookup -- deliberately a different mechanism, matching
 * `maturityBands.ts`'s own "NO COLOURS ARE EXPORTED" discipline one layer
 * up. A single exported constant so the word cannot drift between the
 * scorecard badge, the report ring and the PDF's overall label the way the
 * band ladder itself once did (D-219).
 */
export const VERDICT_WITHHELD_LABEL = 'Verdict withheld';

export const principleSlugMap: Record<string, string> = {
  'Fairness & Non-discrimination': 'fairness',
  'Proportionality & Do Not Harm': 'proportionality',
  'Transparency & Explainability': 'transparency',
  'Reproducibility & Accountability': 'accountability',
  'Safety & Security': 'safety',
  'Awareness & Literacy': 'awareness',
  'Multi-stakeholder Collaboration': 'collaboration',
  'Sustainability': 'sustainability',
};

export const ratingLabels = ['Not at all', 'Minimally', 'Partially', 'Mostly', 'Fully'] as const;
