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
 * `names` once `accounts` have been heard from the server: an account already there takes the name just heard (the latest wins:
 * a deleted account's name becomes "Deleted user", FR-EXP-03), a new one is added. The same array when nothing changes, so the
 * form can record what it heard during render and settle.
 */
export function heardNames(names: readonly NamedAccount[], accounts: ReadonlyArray<NamedAccount | null>): readonly NamedAccount[] {
  let out: NamedAccount[] | null = null;
  for (const a of accounts) {
    if (a === null) continue;
    const list: readonly NamedAccount[] = out ?? names;
    const at = list.findIndex((u) => u.userId === a.userId);
    if (at >= 0 && list[at].name === a.name) continue;
    out ??= [...names];
    if (at >= 0) out[at] = { userId: a.userId, name: a.name }; else out.push({ userId: a.userId, name: a.name });
  }
  return out ?? names;
}

/**
 * The deciders the form can name who are on no member list (they have left the organisation), so the Decided by field can
 * offer them and the conflict view and the who and when line can name them, labelled "(former member)". In order:
 * - the current version's decider (`data.current`);
 * - `opened`, the member decider of the version the form's answer was last opened from: it keeps the person's own decider
 *   offered after a newer version by someone else has become the current one;
 * - `chosen`, the decider the form's answer holds. A draft holds an account id only, so after a page load that restores one,
 *   no version the form knows may name them;
 * - `held`, the account ids of departed deciders the form has shown as the chosen one since it was last drawn from saved data
 *   (DecisionForm `heldDeciders`): one pick of someone else does not take them off the list (ruling P58).
 * Each is named by the latest name the server sent for that account in this tab: `names` (DecisionForm, `heardNames`), then the
 * page (`data.formerDeciders`: the members who decided an earlier version of this question and have since left), then the name
 * the version carried. So once a deleted account has been shown as "Deleted user", no earlier name comes back (FR-EXP-03).
 * Nothing names a member who left without deciding a version: they are listed with no name ("a former member").
 * A name for an account id says nothing about which version is current: the form drawn again from the current version ("Discard
 * my version") opens from it, and then neither the older version's decider nor the answer's earlier one is listed (ruling P38).
 */
export function departedDeciders(
  data: Pick<QuestionPanelData, 'current' | 'members' | 'viewer' | 'formerDeciders'>, opened: NamedAccount | null,
  chosen: Decider | null = null, names: readonly NamedAccount[] = [], held: readonly string[] = [],
): DepartedDecider[] {
  const left = (userId: string): boolean => userId !== data.viewer.userId && !data.members.some((m) => m.userId === userId);
  const latest = (u: DepartedDecider): DepartedDecider => {
    const heard = names.find((n) => n.userId === u.userId) ?? data.formerDeciders?.find((n) => n.userId === u.userId);
    return heard === undefined || heard.name === u.name ? u : heard;
  };
  const out: DepartedDecider[] = [];
  const add = (u: DepartedDecider | null): void => { if (u !== null && left(u.userId) && !out.some((o) => o.userId === u.userId)) out.push(latest(u)); };
  add(memberDecider(data.current));
  add(opened);
  if (chosen?.kind === 'member') add({ userId: chosen.userId, name: null });
  for (const userId of held) add({ userId, name: null });
  return out;
}
