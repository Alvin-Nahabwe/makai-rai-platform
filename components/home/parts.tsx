import type { ReactElement, ReactNode } from 'react';
import type { FindingView, UserRef } from '@/types/api';
import type { HomeBase } from '@/lib/home/types';
import { HOME_COPY } from '@/lib/home/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { runningContent } from '@/lib/content/loader';
import { PROJECT_COPY } from '@/lib/project/copy';
import { Icon } from '@/components/ui/Icon';

/**
 * Small pieces every Home variant shares (plan 1B Task 10). Server only: the finding label reads the running content,
 * and nothing here has state or a handler.
 */

/** Stands where a sentence of HOME_COPY takes a value that is rendered as an element; never shown. */
export const SLOT = '\u0000';

/** A sentence of HOME_COPY with `node` placed where it took `SLOT`, so the words stay in the copy module alone. */
export function withSlot(sentence: string, node: ReactNode): ReactNode {
  const parts = sentence.split(SLOT);
  if (parts.length !== 2) throw new Error(`Home: a sentence must take its value exactly once, got ${parts.length - 1} slots`);
  const [before, after] = parts;
  return <>{before}{node}{after}</>;
}

/** A person's name as Home writes it: isolated, with the vocabulary's "former member" for someone who left. */
export function personName(who: UserRef): ReactNode {
  return <bdi>{who.formerMember ? HOME_COPY.formerMember(who.name) : who.name}</bdi>;
}

/** The project's name when the organisation has more than one active project, so an item says which; otherwise null. */
export function projectNameIfMany(base: HomeBase, projectId: string): string | null {
  if (base.projects.length < 2) return null;
  const project = base.projects.find((p) => p.id === projectId);
  // Every item Home lists comes from an active project of this organisation, so its name is in `projects`; one that is
  // not is a mismatch between the loader's reads, which must not be hidden by leaving the name off.
  if (project === undefined) throw new Error(`Home: an item names project ${projectId}, which is not among the active projects read`);
  return project.name;
}

/**
 * A finding as the findings list names it (lib/findings/pageData.ts `titleOf`): a team finding by its title, a shortfall
 * by its question's words. A team finding cannot be raised without a title, so a null title is an erased one (the
 * erasure instruction blanks it) and says so, in the words Home uses for an erased mitigation. Home has no content
 * version to hand, so a shortfall's words are the running content's; a question the running content no longer holds is
 * named by its code, as titleOf does without a version.
 */
export function findingLabel(f: Pick<FindingView, 'source' | 'title' | 'questionId'>): string {
  if (f.source === 'team') return f.title ?? PROJECT_COPY.followUp.erased;
  if (f.questionId === null) return FINDINGS_COPY.finding.untitled;
  return runningContent().questions.get(f.questionId)?.text ?? f.questionId;
}

/** The red word (spec 7.1: red only on an overdue date and the word "Overdue"), with the clock drawn in the same red. */
export function OverdueWord(): ReactElement {
  return <span className="home-overdue"><Icon name="clock" size={16} />{PROJECT_COPY.followUp.overdue}</span>;
}

/** The parts of a plate's one line of state, joined by the findings list's separator. Parts that are null are left out. */
export function MetaLine({ parts }: { parts: ReadonlyArray<ReactNode | null> }): ReactElement {
  const shown = parts.filter((p) => p !== null);
  return (
    <p className="home-plate__meta">
      {shown.map((p, i) => <span key={i}>{i > 0 ? FINDINGS_COPY.separator : null}{p}</span>)}
    </p>
  );
}
