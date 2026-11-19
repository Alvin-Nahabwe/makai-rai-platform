import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevelopmentStage } from '@prisma/client';
import { buildLoadedContent } from '@/lib/content/loader';
import type { LoadedContent } from '@/types/content';
import type { Stage } from '@/types/record';

/**
 * In-memory content for the two keys the fixture bundles do not carry: the fixture 0.0.1 bundle with
 * `projectConfig.json` merged with `over`, built through the real loader (so the loader's checks apply).
 */
const DIR = join(process.cwd(), '__tests__', 'fixtures', 'content', '0.0.1-fixture');

/** The owner's table for stage applicability (G7): which stages apply at each development stage. */
export const OWNER_TABLE: Readonly<Record<DevelopmentStage, readonly Stage[]>> = {
  concept: ['pre-processing'],
  development: ['pre-processing', 'in-processing'],
  testing: ['pre-processing', 'in-processing', 'post-processing'],
  deployed: ['pre-processing', 'in-processing', 'post-processing'],
  retired: ['pre-processing', 'in-processing', 'post-processing'],
};

export function contentWith(over: { stageApplicability?: unknown; controlSuggestionsApproved?: unknown }): LoadedContent {
  const read = (file: Parameters<Parameters<typeof buildLoadedContent>[1]>[0]): Uint8Array => {
    const bytes = readFileSync(join(DIR, file));
    if (file !== 'projectConfig.json') return bytes;
    const merged = { ...(JSON.parse(bytes.toString('utf8')) as Record<string, unknown>), ...over };
    return new TextEncoder().encode(JSON.stringify(merged));
  };
  return buildLoadedContent('0.0.1-fixture', read);
}
