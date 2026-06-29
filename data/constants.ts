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

export const levelLabels: Record<string, string> = {
  critical: 'Critical',
  needsWork: 'Needs Work',
  developing: 'Developing',
  strong: 'Strong',
};

export const levelColors: Record<string, string> = {
  critical: '#DC2626',
  needsWork: '#F97316',
  developing: '#FACC15',
  strong: '#22C55E',
};

export const levelDescriptions: Record<string, string> = {
  critical: 'Significant gaps that need immediate attention',
  needsWork: 'Notable areas requiring focused improvement',
  developing: 'Progress evident with room for further development',
  strong: 'Comprehensive practices demonstrating maturity',
};

export const ratingLabels = ['Not at all', 'Minimally', 'Partially', 'Mostly', 'Fully'] as const;
