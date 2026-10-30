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
