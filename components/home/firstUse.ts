import type { Stage } from '@/types/record';
import type { HomeData } from '@/lib/home/types';

/**
 * The terms Home defines in named term lists at their first use (spec 6; lane lead's ruling of fix round 2): "finding",
 * "mitigation" and "seal", plus the three stage names on a Reviewer's Home, which has no stage plates. Every stage plate
 * carries its own stage's definition, so stage names need no walk where there are plates.
 */
export type UseTerm = Stage | 'finding' | 'mitigation' | 'seal';

/** The three stage names in their order, for the Reviewer's one stage term list. */
const STAGE_TERMS: readonly Stage[] = ['pre-processing', 'in-processing', 'post-processing'];

/** The order of a recorder's sections (one source for HomeView's layout and this walk). */
export type RecorderSection = 'next' | 'assigned' | 'since' | 'lead' | 'stages';

/**
 * The recorder's two columns, in document order (= reading order). With a next step, the sketch's composition: the next
 * step, "Assigned to you" and "Since…" on the left; the lead lists and the stages on the right. Without one (an Owner or
 * Admin who has not recorded, spec 9.1), the stages and the lead lists take the left, main column so the stages start in
 * the first view and their "Next:" links are the way in; "Assigned to you" and "Since…" move to the right (fix round 2, #8).
 */
export function recorderColumns(data: Extract<HomeData, { variant: 'recorder' }>): [RecorderSection[], RecorderSection[]] {
  return data.next === null ? [['lead', 'stages'], ['assigned', 'since']] : [['next', 'assigned', 'since'], ['lead', 'stages']];
}

/**
 * Where each term is first used, as the name of the section whose term list defines it (`terms:<section>` keys). A section
 * counts only when it shows an item that uses the term (no term list over an empty list, design review #13).
 */
export class FirstUses {
  private readonly at = new Map<UseTerm, string>();

  /** Records that `where` uses `terms`; only the first place of each term is kept. */
  use(where: string, ...terms: UseTerm[]): void {
    for (const t of terms) if (!this.at.has(t)) this.at.set(t, where);
  }

  /** The terms whose first use is `where`, in the order they were recorded. */
  definedAt(where: string): UseTerm[] {
    return [...this.at].filter(([, w]) => w === where).map(([t]) => t);
  }
}

type Changes = ReadonlyArray<{ kind: 'decisions' | 'finding' | 'seal' }>;
type Plates = ReadonlyArray<{ openFindings: number; overdueMitigations: number }>;

const changeTerms = (groups: Changes): UseTerm[] => [
  ...(groups.some((g) => g.kind === 'finding') ? ['finding' as const] : []),
  ...(groups.some((g) => g.kind === 'seal') ? ['seal' as const] : []),
];
const plateTerms = (stages: Plates): UseTerm[] => [
  ...(stages.some((s) => s.openFindings > 0) ? ['finding' as const] : []),
  ...(stages.some((s) => s.overdueMitigations > 0) ? ['mitigation' as const] : []),
];

/**
 * Walks a Home's sections in the order the page shows them and records the first section that uses each term. A change
 * to a section's content or order must move here too; home-view.test.tsx reads the rendered page to check it.
 */
export function firstUsesOf(data: HomeData): FirstUses {
  const uses = new FirstUses();
  switch (data.variant) {
    case 'recorder': {
      for (const section of recorderColumns(data).flat()) {
        if (section === 'assigned' && data.assigned.length > 0) uses.use('terms:assigned', 'mitigation', 'finding');
        if (section === 'since' && data.since !== null) uses.use('terms:since', ...changeTerms(data.since.groups));
        if (section === 'lead' && data.lead !== null) {
          if (data.lead.overdue.length > 0) uses.use('terms:lead-overdue', 'mitigation');
          if (data.lead.withoutMitigation.length > 0) uses.use('terms:lead-none', 'finding', 'mitigation');
        }
        if (section === 'stages' && data.focus !== null) uses.use(`terms:project:${data.focus.projectId}`, ...plateTerms(data.focus.stages));
      }
      return uses;
    }
    case 'reviewer': {
      // The three stage definitions go once, as one list, at the first section that names a stage (it has no plates).
      const sections: Array<[string, number, UseTerm[]]> = [
        ['assigned', data.assigned.length, ['mitigation', 'finding']],
        ['unsealed', data.unsealed.length, []],
        ['changed', data.changedSinceSeal.length, ['seal']],
        ['raised', data.raisedByMe.length, ['finding']],
      ];
      for (const [name, items, terms] of sections) {
        if (items === 0) continue;
        uses.use(`terms:${name}`, ...terms);
        uses.use(`stages:${name}`, ...STAGE_TERMS);
      }
      return uses;
    }
    case 'viewer': {
      if (data.assigned.length > 0) uses.use('terms:assigned', 'mitigation', 'finding');
      uses.use('terms:recent', ...changeTerms(data.recent.groups));
      for (const p of data.open) uses.use(`terms:project:${p.projectId}`, ...plateTerms(p.stages));
      return uses;
    }
    case 'first-time':
      return uses;
    default: {
      const unknown: never = data;
      throw new Error(`firstUsesOf: no Home variant ${String((unknown as { variant: unknown }).variant)}`);
    }
  }
}
