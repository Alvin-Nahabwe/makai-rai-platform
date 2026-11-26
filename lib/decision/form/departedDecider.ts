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

/** What the form has heard from the server: the page data and the newest version a save's reply named, and the names they gave. */
export type Heard = { page: QuestionPanelData | null; newest: DecisionVersionView | null; names: readonly NamedAccount[] };

/**
 * `prev` once the form holds `page` and `newest`, each heard when it is a new object, as it arrives (ruling P61: for each account,
 * the name shown is the one the server sent last, by arrival). A new page gives its `formerDeciders` and its current version's
 * decider; a new `newest` (a version a save's reply named, even one the page already holds) gives its decider. One source never
 * re-hears the other: page data arriving after a reply wins over the reply's name, and a reply arriving after the page wins over
 * the page's. If both are new in the same render the reply is heard last. `prev` itself when nothing changed, so the form can
 * record this during render and settle.
 */
export function hear(prev: Heard, page: QuestionPanelData, newest: DecisionVersionView | null): Heard {
  if (prev.page === page && prev.newest === newest) return prev;
  const accounts: Array<NamedAccount | null> = [];
  if (prev.page !== page) accounts.push(...(page.formerDeciders ?? []), memberDecider(page.current));
  if (prev.newest !== newest) accounts.push(memberDecider(newest));
  return { page, newest, names: heardNames(prev.names, accounts) };
}

/**
 * `v` with its member decider named by the latest name heard for that account (the conflict view's saved column shows the reply's
 * version, which may carry a name the page has since replaced). `v` itself when that name is already its own.
 */
export const withLatestDecider = (v: DecisionVersionView, names: readonly NamedAccount[]): DecisionVersionView => {
  const d = v.decidedBy;
  if (d?.kind !== 'member') return v;
  const latest = names.find((u) => u.userId === d.user.userId);
  return latest === undefined || latest.name === d.user.name ? v : { ...v, decidedBy: { ...d, user: { ...d.user, name: latest.name } } };
};

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
