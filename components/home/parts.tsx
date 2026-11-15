import { Fragment, type ReactElement, type ReactNode } from 'react';
import type { FindingView, UserRef } from '@/types/api';
import type { Stage } from '@/types/record';
import type { HomeBase } from '@/lib/home/types';
import type { DefinedEntry } from '@/lib/vocabulary/types';
import { HOME_COPY } from '@/lib/home/copy';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import { runningContent } from '@/lib/content/loader';
import { PROJECT_COPY } from '@/lib/project/copy';
import { TERM_FINDING, TERM_MITIGATION, TERM_SEAL, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import { Icon } from '@/components/ui/Icon';
import { Definition, Term } from '@/components/ui/Definition';
import { STAGE_NAME } from '@/components/project/StageColumn';
import type { FirstUses, UseTerm } from '@/components/home/firstUse';

/**
 * Small pieces every Home variant shares (plan 1B Task 10). Server only: the finding label reads the running content,
 * and nothing here has state or a handler.
 */

/** Stand where a sentence of HOME_COPY takes a value that is rendered as an element; never shown. */
export const SLOT = '\u0000';
export const SLOT_2 = '\u0001';

/** A sentence of HOME_COPY with `node` placed where it took `SLOT`, so the words stay in the copy module alone. */
export function withSlot(sentence: string, node: ReactNode): ReactNode {
  return withSlots(sentence, [node]);
}

/** A sentence with its first value where it took `SLOT` and its second where it took `SLOT_2`, each exactly once. */
export function withSlots(sentence: string, nodes: readonly ReactNode[]): ReactNode {
  const marks = [SLOT, SLOT_2].slice(0, nodes.length);
  for (const m of marks) {
    if (sentence.split(m).length !== 2) throw new Error(`Home: a sentence must take each of its ${nodes.length} values exactly once`);
  }
  const parts = sentence.split(new RegExp(`(${marks.join('|')})`));
  return <>{parts.map((part, i) => {
    const at = marks.indexOf(part);
    return at === -1 ? part : <Fragment key={i}>{nodes[at]}</Fragment>;
  })}</>;
}

/** The vocabulary entry behind each term Home defines at its first use. */
export const TERM_OF: Readonly<Record<UseTerm, DefinedEntry>> = {
  'pre-processing': TERM_STAGE_1, 'in-processing': TERM_STAGE_2, 'post-processing': TERM_STAGE_3,
  finding: TERM_FINDING, mitigation: TERM_MITIGATION, seal: TERM_SEAL,
};

/** A stage's name, marked as a use of its term (spec 6), so its first use can carry the definition beside it. */
export function StageName({ stage }: { stage: Stage }): ReactElement {
  return <Term of={TERM_OF[stage]}>{STAGE_NAME[stage]}</Term>;
}

/** The definitions of the terms first used at `where`, each as its own line (spec 6). Nothing when none is. */
export function Defs({ uses, where }: { uses: FirstUses; where: string }): ReactElement | null {
  const terms = uses.definedAt(where);
  if (terms.length === 0) return null;
  return <>{terms.map((t) => <Definition key={t} of={TERM_OF[t]} as="p" />)}</>;
}

/**
 * A section heading that itself uses terms ("Findings you raised", "Overdue mitigations"): when the heading is a term's
 * first use, its words are marked with each such term and the definitions follow it as lines (spec 6). A term list would
 * repeat the word after the heading, so these sections use this instead.
 */
export function TermHeading({ uses, where, text }: { uses: FirstUses; where: string; text: string }): ReactElement {
  const terms = uses.definedAt(where);
  const marked = terms.reduce<ReactNode>((inner, t) => <Term of={TERM_OF[t]}>{inner}</Term>, text);
  return (
    <>
      <h2>{marked}</h2>
      <Defs uses={uses} where={where} />
    </>
  );
}

/** The words a term list writes for each term (the sketch's note under "Waiting on you", as a list). */
const TERM_WORD: Readonly<Record<UseTerm, string>> = {
  'pre-processing': STAGE_NAME['pre-processing'], 'in-processing': STAGE_NAME['in-processing'], 'post-processing': STAGE_NAME['post-processing'],
  finding: 'Finding', mitigation: 'Mitigation', seal: 'Seal',
};

/**
 * The terms first used in a section, with their definitions, as a short list under its heading (the sketch defines
 * "mitigation" and "finding" under "Assigned to you"). Each term is a <dt> marked with `Term`, its definition the <dd>
 * right after it. Nothing when the section uses no term for the first time.
 */
export function TermList({ uses, where }: { uses: FirstUses; where: string }): ReactElement | null {
  const terms = uses.definedAt(where);
  if (terms.length === 0) return null;
  return (
    <dl className="home-terms">
      {terms.map((t) => (
        <div key={t} className="home-terms__pair">
          <dt><Term of={TERM_OF[t]}>{TERM_WORD[t]}</Term></dt>
          <dd><Definition of={TERM_OF[t]} /></dd>
        </div>
      ))}
    </dl>
  );
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
