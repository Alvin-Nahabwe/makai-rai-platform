import type { ContentQuestion, LoadedContent, LoadedQuestion } from '@/types/content';

/**
 * A question's risk areas (plan 1C Task 4; owner's answer 17.5): its `gaps` ids first, then the area of every option in
 * its `optionGapMap`, each id once. This is QC-02's FULL reading, and the content validator (lib/content/validate.ts)
 * reads it through this function, so the page and the validator cannot disagree. The validator hands in content that
 * has not been checked yet, so the walk takes unknown shapes and keeps only string ids; a malformed entry is the
 * validator's to report, through its own checks on `gaps` and `optionGapMap`, not this function's.
 */
export function riskAreaIdsOf(q: Pick<ContentQuestion, 'gaps' | 'optionGapMap'> | { gaps?: unknown; optionGapMap?: unknown }): string[] {
  const out = new Set<string>();
  if (Array.isArray(q.gaps)) for (const id of q.gaps) if (typeof id === 'string') out.add(id);
  const map = q.optionGapMap;
  if (map !== null && typeof map === 'object' && !Array.isArray(map)) {
    for (const list of Object.values(map as Record<string, unknown>)) {
      if (!Array.isArray(list)) continue;
      for (const e of list as unknown[]) {
        const area = typeof e === 'string' ? e : (e !== null && typeof e === 'object' ? (e as { area?: unknown }).area : undefined);
        if (typeof area === 'string') out.add(area);
      }
    }
  }
  return [...out];
}

/** Where a risk area's label links: its card on the Guidance framework page (`area-card-<id>`, app/(authenticated)/explore/framework/page.tsx). */
export const riskAreaHref = (id: string): string => `/explore/framework#area-card-${id}`;

/**
 * The risk areas the question page lists under "Why this is asked": each with its name in words and its link. An id the
 * content does not hold is a defect in the content (the validator refuses such a bundle), so it throws naming it rather
 * than dropping a label the reader should see.
 */
export function riskAreasOf(q: LoadedQuestion, c: LoadedContent): Array<{ id: string; name: string; href: string }> {
  return riskAreaIdsOf(q).map((id) => {
    const area = c.areas.get(id);
    if (area === undefined) throw new Error(`riskAreasOf: question ${q.id} names risk area ${id}, which content ${c.semver} does not hold`);
    return { id, name: area.name, href: riskAreaHref(id) };
  });
}
