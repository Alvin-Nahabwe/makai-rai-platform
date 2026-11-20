import type { LoadedContent } from '@/types/content';
import { STAGES, type Stage } from '@/types/record';

/**
 * Which assessment stages apply to a project at its development stage (G7). The table is content's
 * (`LoadedContent.stageApplicability`); content with no table leaves G7 dormant, and then every stage applies.
 * Pure: no I/O, no clock.
 */
export function stagesThatApply(c: Pick<LoadedContent, 'stageApplicability'>, developmentStage: string | null): ReadonlySet<Stage> {
  const table = c.stageApplicability;
  if (table === null || developmentStage === null) return new Set(STAGES);
  if (!Object.hasOwn(table, developmentStage)) throw new Error(`stagesThatApply: unknown development stage ${JSON.stringify(developmentStage)}`);
  const applies = table[developmentStage as keyof typeof table];
  return new Set(STAGES.filter((s) => applies.includes(s)));
}

/** The first stage after `after`, in STAGES order, that is in `applies`; null when none follows. */
export function nextStageThatApplies(applies: ReadonlySet<Stage>, after: Stage): Stage | null {
  return STAGES.slice(STAGES.indexOf(after) + 1).find((s) => applies.has(s)) ?? null;
}
