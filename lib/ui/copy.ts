import type { ScopeAnswer, SortWords, StatusMarkKind } from '@/components/ui/types';
import { FIELD_COPY } from '@/lib/ui/field/copy';
import type { Tally } from '@/lib/ui/marks';

/**
 * Interface words of the components/ui kit (plan 1A). Components read their words from here, never from a literal,
 * so a later copy pass changes one file. Sample text on the development gallery is not interface text and stays there.
 */

const SCOPE_ANSWER_WORDS: Readonly<Record<ScopeAnswer, string>> = { yes: 'Yes', no: 'No', not_sure: 'Not sure' };

/** The words of each status mark (spec 7.2). */
export const STATUS_MARK_COPY = {
  done: 'Done',
  partly: 'Partly',
  not_yet: 'Not yet',
  not_applicable: 'Not applicable',
  does_not_apply: 'Does not apply (from your answer to the personal data question)',
  scope_answered: (a: ScopeAnswer) => `Answer: ${SCOPE_ANSWER_WORDS[a]}`,
  no_decision: 'No decision',
  noEvidence: 'no evidence attached',
} as const;

/**
 * Each kind as a tally writes it after its count: [one, more than one]. Order is the order of spec 7.2's table.
 * The owner's decisions of 13 November 2026: the personal data question is counted in a tally, as "1 answered", and
 * tally labels agree in number ("1 does not apply", "3 do not apply"; "no decision" and "not yet" do not change).
 */
const TALLY_WORDS: ReadonlyArray<readonly [StatusMarkKind, string, string]> = [
  ['done', 'done', 'done'],
  ['partly', 'partly', 'partly'],
  ['not_yet', 'not yet', 'not yet'],
  ['not_applicable', 'not applicable', 'not applicable'],
  ['does_not_apply', 'does not apply', 'do not apply'],
  ['scope_answered', 'answered', 'answered'],
  ['no_decision', 'no decision', 'no decision'],
];

export const UI_COPY = {
  marks: {
    /**
     * The personal data question's mark when the caller has no answer to give (a route row stop without `scopeAnswer`).
     * The owner's decision of 13 November 2026: the mark reads "Answered" where no answer is at hand.
     */
    answered: 'Answered',
  },
  tally: {
    none: 'No decisions recorded yet',
    noEvidence: (n: number) => `(${n} with no evidence attached)`,
  },
  position: (n: number, of: number) => `Question ${n} of ${of}`,
  saved: {
    title: (version: number) => `Saved as version ${version}`,
    decidedOn: 'Decided on',
    savedAt: 'Saved',
    onPlatform: 'This decision is saved on the platform.',
    /** The words before and the linked words of "Version {n} is kept in the history." */
    keptBefore: (version: number) => `Version ${version} is kept in `,
    keptLink: 'the history',
  },
  /** The three boxes of a date and its shortcut (DateField). */
  date: { day: 'Day', month: 'Month', year: 'Year', today: 'Today' },
  /** InlineConfirm's cancel button, unless the caller names it. */
  confirm: { cancel: 'Cancel' },
  /** The form fields' words live in lib/ui/field/copy.ts so a page with a form does not download this whole list. */
  field: FIELD_COPY,
  /** Table's visually hidden sort line: "Sorted by Opened, latest first" (phrases: SORT_WORDS or the column's own). */
  table: { sorted: (column: string, phrase: string) => `Sorted by ${column}, ${phrase}` },
  breadcrumbLabel: 'Breadcrumb',
  plate: { youAreHere: 'You are here' },
  /** After a done step's name, visually hidden. */
  stepper: { done: '(done)' },
} as const;

/**
 * The owner's decision of 13 November 2026, "Words that fit the column": a sorted column is announced in its own words,
 * never "ascending"/"descending". Keys are aria-sort's two values; the values are what a person hears.
 */
export const SORT_WORDS: Readonly<Record<'date' | 'name' | 'number', SortWords>> = {
  date: { ascending: 'earliest first', descending: 'latest first' },
  name: { ascending: 'A to Z', descending: 'Z to A' },
  number: { ascending: 'lowest first', descending: 'highest first' },
};

/**
 * A tally in words (spec 7.2): "9 done (2 with no evidence attached), 6 partly, 2 not yet, 1 no decision". Kinds with
 * a zero or no count are left out; there is never a total, a share or a percentage.
 */
export function tallyWords(t: Tally): string {
  const parts: string[] = [];
  for (const [kind, one, many] of TALLY_WORDS) {
    const n = t[kind] ?? 0;
    if (n <= 0) continue;
    let part = `${n} ${n === 1 ? one : many}`;
    if (kind === 'done' && (t.doneNoEvidence ?? 0) > 0) part += ` ${UI_COPY.tally.noEvidence(t.doneNoEvidence ?? 0)}`;
    parts.push(part);
  }
  return parts.length === 0 ? UI_COPY.tally.none : parts.join(', ');
}

/** A question's place in its stage: "Question 4 of 22", never its code (codes are not consecutive). */
export function positionWords(n: number, of: number): string {
  return UI_COPY.position(n, of);
}
