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
 * The one name source of the decision form. `prev` once the form holds `page` and `newest`, each heard when it is a
 * new object, as it arrives (ruling P61: for each account, the name shown is the one the server sent last, by arrival). A new page
 * gives every name it carries: its viewer, its listed members, its `formerDeciders` and its current version's decider and author
 * (who entered it); a new `newest` (a version a save's reply named, even one the page already holds) gives its decider and author.
 * One source never re-hears the other: page data arriving after a reply wins over the reply's names, and a reply arriving after
 * the page wins over the page's. If both are new in the same render the reply is heard last. `prev` itself when nothing changed,
 * so the form can record this during render and settle.
 *
 * Every place that names an account reads `names` through one of three readers, never the object a name first came in:
 * `panelWithLatestNames` (the panel the form reads: the field, its options, the who and when line, "Your version"),
 * `withLatestNames` (a version shown as it is: the conflict view's newer version and its sentence, a save's status line, the
 * card line) and `departedDeciders` (an account id no panel names: a decider a draft holds).
 */
export function hear(prev: Heard, page: QuestionPanelData, newest: DecisionVersionView | null): Heard {
  if (prev.page === page && prev.newest === newest) return prev;
  const accounts: Array<NamedAccount | null> = [];
  if (prev.page !== page) accounts.push(page.viewer, ...page.members, ...(page.formerDeciders ?? []), memberDecider(page.current), page.current?.enteredBy ?? null);
  if (prev.newest !== newest) accounts.push(memberDecider(newest), newest?.enteredBy ?? null);
  return { page, newest, names: heardNames(prev.names, accounts) };
}

/** `u` under the latest name heard for its account; `u` itself when that is already its name, or when nothing heard names it. */
const latestOf = <U extends NamedAccount>(u: U, names: readonly NamedAccount[]): U => {
  const heard = names.find((n) => n.userId === u.userId);
  return heard === undefined || heard.name === u.name ? u : { ...u, name: heard.name };
};

/**
 * `v` with its member decider and its author (who entered it) named by the latest name heard for each account: the conflict view's
 * saved column and sentence show the reply's version, and the card line the page's, either of which may carry a name the tab has
 * since been sent anew. `v` itself when both names are already its own.
 */
export const withLatestNames = (v: DecisionVersionView, names: readonly NamedAccount[]): DecisionVersionView => {
  const d = v.decidedBy;
  const user = d?.kind === 'member' ? latestOf(d.user, names) : null;
  const enteredBy = latestOf(v.enteredBy, names);
  if (enteredBy === v.enteredBy && (d?.kind !== 'member' || user === d.user)) return v;
  return { ...v, enteredBy, decidedBy: d?.kind === 'member' && user !== null ? { ...d, user } : d };
};

/**
 * `panel` with every account the form names from it under the latest name heard: the viewer, each listed member, and the current
 * version's decider and author (`withLatestNames`). The form reads this panel and nothing else for those names, so the Decided by
 * field, its options, the who and when line and "Your version" take a name a reply or a refresh brought with no lookup of their
 * own; a member the page listed who has since deleted their account reads "Deleted user" in all of them (FR-EXP-03). Names only:
 * who the page lists as a member, and the former-member mark each version carries, stay as the server sent them. `panel` itself
 * when every name is already the latest, so what the form derives from it settles.
 */
export function panelWithLatestNames(panel: QuestionPanelData, names: readonly NamedAccount[]): QuestionPanelData {
  const viewer = latestOf(panel.viewer, names);
  const members = panel.members.map((m) => latestOf(m, names));
  const current = panel.current === null ? null : withLatestNames(panel.current, names);
  if (viewer === panel.viewer && current === panel.current && members.every((m, i) => m === panel.members[i])) return panel;
  return { ...panel, viewer, members, current };
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
