import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionVersionView } from '@/types/api';
import type { Decider } from '@/types/record';
import { WHO_WHEN_COPY } from '@/lib/decision/copy';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';

/** An account as a version names it. */
export type NamedAccount = { userId: string; name: string };
/** A decider who has left, with the name a version or the page gives them; null when nothing the page holds names them. */
export type DepartedDecider = { userId: string; name: string | null };

/** The member a version names as its decider; null for an outside role, a withdrawal, or no version. */
export const memberDecider = (v: DecisionVersionView | null): NamedAccount | null => (v?.decidedBy?.kind === 'member' ? v.decidedBy.user : null);

/** How the form labels a decider who has left: "<name> (former member)", or "a former member" when nothing names them. */
export const departedLabel = (u: DepartedDecider): string => (u.name === null ? WHO_WHEN_COPY.formerMember : DECISION_FORM_COPY.formerMember(u.name));

/**
 * The deciders the form can name who are on no member list (they have left the organisation), so the Decided by field can
 * offer them and the conflict view and the who and when line can name them, labelled "(former member)". In order:
 * - the current version's decider (`data.current`);
 * - `opened`, the member decider of the version the form's answer was last opened from: it keeps the person's own decider
 *   offered after a newer version by someone else has become the current one;
 * - `chosen`, the decider the form's answer holds, when neither of those is them. A draft holds an account id only, so after a
 *   page load that restores one, no version the form knows may name them. Their name then comes from the page
 *   (`data.formerDeciders`: the members who decided an earlier version of this question and have since left, with the name
 *   the server holds now) or from `seen`, the member deciders of the versions this form has shown as the current one (a
 *   version a save's reply named, then replaced by a newer one, is on no page this browser loaded). Nothing names a member
 *   who left without deciding a version: they are listed with no name ("a former member").
 * The page's name wins over the name `opened` or `seen` carries, which may be from before the account was deleted (FR-EXP-03).
 * A name for an account id says nothing about which version is current: the form drawn again from the current version ("Discard
 * my version") opens from it, and then neither the older version's decider nor the answer's earlier one is listed (ruling P38).
 */
export function departedDeciders(
  data: Pick<QuestionPanelData, 'current' | 'members' | 'viewer' | 'formerDeciders'>, opened: NamedAccount | null,
  chosen: Decider | null = null, seen: readonly NamedAccount[] = [],
): DepartedDecider[] {
  const left = (userId: string): boolean => userId !== data.viewer.userId && !data.members.some((m) => m.userId === userId);
  const fromPage = (userId: string): NamedAccount | undefined => data.formerDeciders?.find((u) => u.userId === userId);
  const out: DepartedDecider[] = [];
  const add = (u: DepartedDecider | null): void => { if (u !== null && left(u.userId) && !out.some((o) => o.userId === u.userId)) out.push(u); };
  add(memberDecider(data.current));
  add(opened === null ? null : fromPage(opened.userId) ?? opened);
  if (chosen?.kind === 'member') {
    add(fromPage(chosen.userId) ?? seen.find((u) => u.userId === chosen.userId) ?? { userId: chosen.userId, name: null });
  }
  return out;
}
