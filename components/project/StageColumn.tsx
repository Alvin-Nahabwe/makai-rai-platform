import type { Stage } from '@/types/record';
import { PROJECT_COPY } from '@/lib/project/copy';

/**
 * The stage names and the count helper that Home's cards and the project card share with S-10 (the project page itself
 * is components/project/ProjectPage.tsx since lane 4 Task A; its stages are StageLine.tsx).
 */
export const STAGE_NAME: Readonly<Record<Stage, string>> = PROJECT_COPY.stageNames;

/** "1 question", "2 questions". */
export const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
