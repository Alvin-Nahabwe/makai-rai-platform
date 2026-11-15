import type { Stage } from '@/types/record';
import type { HomeData } from '@/lib/home/types';

/** How many plates each of an Owner's or Admin's lists shows before its link to the whole list (lane lead, fix round 1). */
export const LEAD_CAP = 5;

/** The terms Home defines at their first use (spec 6): the three stage names, "finding", "mitigation" and "seal". */
export type UseTerm = Stage | 'finding' | 'mitigation' | 'seal';

/**
 * Where each term is first used on a Home, in reading order (spec 6: "the definition of a term is shown where it first
 * appears on a screen"). A place is a string key that the component drawing it asks about: `next` (the next-step card's
 * "where" line), `terms:<section>` (a section's term list under its heading), `assigned:<id>`, `change:<i>`,
 * `lead-overdue:<id>`, `lead-finding:<id>`, `review:<id>`, `raised:<id>`, `plate:<project>:<stage>`.
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

/**
 * Walks a Home's data in the order the page shows it, which is the order HomeView renders: the welcome header uses none
 * of the terms (its words are the person's name and fixed sentences), so the walk starts at the variant's first column.
 * A component change that moves a use must move it here too; home-view.test.tsx reads the rendered page to check that
 * each definition follows its term's first use.
 */
export function firstUsesOf(data: HomeData): FirstUses {
  const uses = new FirstUses();
  const assigned = (items: ReadonlyArray<{ mitigationId: string; stage: Stage }>, always: boolean) => {
    if (!always && items.length === 0) return;
    uses.use('terms:assigned', 'mitigation', 'finding');
    for (const i of items) uses.use(`assigned:${i.mitigationId}`, i.stage);
  };
  const changes = (groups: ReadonlyArray<{ kind: 'decisions' | 'finding' | 'seal'; stage: Stage }>) => {
    groups.forEach((g, i) => uses.use(`change:${i}`, ...(g.kind === 'finding' ? ['finding' as const] : g.kind === 'seal' ? ['seal' as const] : []), g.stage));
  };
  const plates = (projectId: string, stages: ReadonlyArray<{ stage: Stage; openFindings: number; overdueMitigations: number }>) => {
    for (const s of stages) {
      uses.use(`plate:${projectId}:${s.stage}`, s.stage, ...(s.openFindings > 0 ? ['finding' as const] : []), ...(s.overdueMitigations > 0 ? ['mitigation' as const] : []));
    }
  };
  switch (data.variant) {
    case 'recorder': {
      if (data.next !== null) uses.use('next', data.next.stage);
      assigned(data.assigned, true);
      if (data.since !== null) changes(data.since.groups);
      if (data.lead !== null) {
        if (data.lead.overdue.length > 0) uses.use('terms:lead-overdue', 'mitigation');
        for (const i of data.lead.overdue.slice(0, LEAD_CAP)) uses.use(`lead-overdue:${i.mitigationId}`, i.stage);
        if (data.lead.withoutMitigation.length > 0) uses.use('terms:lead-none', 'finding', 'mitigation');
        for (const f of data.lead.withoutMitigation.slice(0, LEAD_CAP)) uses.use(`lead-finding:${f.id}`, f.stage);
      }
      if (data.focus !== null) plates(data.focus.projectId, data.focus.stages);
      return uses;
    }
    case 'reviewer': {
      assigned(data.assigned, false);
      for (const r of data.unsealed) uses.use(`review:${r.id}`, r.stage);
      uses.use('terms:changed', 'seal');
      for (const r of data.changedSinceSeal) uses.use(`review:${r.id}`, r.stage);
      uses.use('terms:raised', 'finding');
      for (const f of data.raisedByMe) uses.use(`raised:${f.id}`, f.stage);
      return uses;
    }
    case 'viewer': {
      assigned(data.assigned, false);
      changes(data.recent.groups);
      uses.use('terms:still-open', 'mitigation', 'finding');
      for (const p of data.open) plates(p.projectId, p.stages);
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
