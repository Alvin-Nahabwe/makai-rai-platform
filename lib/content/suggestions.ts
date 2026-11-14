import type { ContentArea, ContentControl, LoadedContent } from '@/types/content';
import type { Stage } from '@/types/record';

/**
 * Controls for a question or risk area (FR-SUG-01 to 03, UX-13). A pure function of the loaded content: no I/O, no clock.
 */

export type ControlGroup = {
  area: ContentArea;
  controls: Array<{ control: ContentControl; alsoAddresses: string[]; usuallyAppliedIn: Stage | null }>;
};

const areaOfEntry = (e: string | { area: string }): string => (typeof e === 'string' ? e : e.area);

const unique = (xs: readonly string[]): string[] => [...new Set(xs)];

/** The controls of an area that the content defines; an id the content does not define is the loader's problem, not shown. */
function controlsOf(c: LoadedContent, area: ContentArea): ContentControl[] {
  const out: ContentControl[] = [];
  for (const id of area.controls ?? []) {
    const control = c.controls.get(id);
    if (control) out.push(control);
  }
  return out;
}

/**
 * Turns an ordered list of area ids into groups. Each control is placed once, under the first area that reaches it;
 * `alsoAddresses` lists the other areas of `allAreaIds` that include it; a group left with no control is dropped.
 * `placed` carries the controls already shown by an earlier call, so first groups win over rest groups.
 */
function group(
  c: LoadedContent, areaIds: readonly string[], allAreaIds: readonly string[], questionStage: Stage, placed: Set<string>,
): ControlGroup[] {
  const groups: ControlGroup[] = [];
  for (const areaId of areaIds) {
    const area = c.areas.get(areaId);
    if (!area) continue;
    const controls: ControlGroup['controls'] = [];
    for (const control of controlsOf(c, area)) {
      if (placed.has(control.id)) continue;
      placed.add(control.id);
      const alsoAddresses = allAreaIds.filter((other) => other !== areaId && c.areas.get(other)?.controls?.includes(control.id));
      controls.push({ control, alsoAddresses, usuallyAppliedIn: area.stage !== questionStage ? area.stage : null });
    }
    if (controls.length > 0) groups.push({ area, controls });
  }
  return groups;
}

/**
 * The risk areas a question reaches through the mapping: its `gaps`, then the areas of its options' `optionGapMap`, each once.
 * None for the gate or a question the content lacks (as `controlsForQuestion` shows none for them).
 */
export function questionAreaIds(c: LoadedContent, questionId: string): string[] {
  const q = c.questions.get(questionId);
  if (!q || q.type === 'gate') return [];
  const map = q.optionGapMap ?? {};
  return unique([...q.gaps, ...(q.options ?? []).flatMap((o) => (map[o] ?? []).map(areaOfEntry))]);
}

export function controlsForQuestion(
  c: LoadedContent, questionId: string, tickedOptions: readonly string[],
): { first: ControlGroup[]; rest: ControlGroup[] } {
  const q = c.questions.get(questionId);
  if (!q || q.type === 'gate') return { first: [], rest: [] };

  const options = q.options ?? [];
  const map = q.optionGapMap ?? {};
  const areasOfOption = (o: string): string[] => (map[o] ?? []).map(areaOfEntry);
  const all = questionAreaIds(c, questionId);

  let firstIds = all;
  let restIds: string[] = [];
  if (q.type === 'checklist') {
    // Only the question's own options count: a ticked string that is not an option is ignored (G7).
    const ticked = new Set(tickedOptions.filter((t) => options.includes(t)));
    firstIds = unique(options.filter((o) => !ticked.has(o)).flatMap(areasOfOption));
    restIds = all.filter((a) => !firstIds.includes(a));
  }

  const placed = new Set<string>();
  const first = group(c, firstIds, all, q.stage, placed);
  const rest = group(c, restIds, all, q.stage, placed);
  return { first, rest };
}

export function controlsForArea(c: LoadedContent, areaId: string): ControlGroup[] {
  const area = c.areas.get(areaId);
  if (!area) return [];
  const controls = controlsOf(c, area).map((control) => ({ control, alsoAddresses: [] as string[], usuallyAppliedIn: null }));
  return [{ area, controls }];
}
