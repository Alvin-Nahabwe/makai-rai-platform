import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionVersionView } from '@/types/api';

/** An account as a version names it. */
export type NamedAccount = { userId: string; name: string };

/** The member a version names as its decider; null for an outside role, a withdrawal, or no version. */
export const memberDecider = (v: DecisionVersionView | null): NamedAccount | null => (v?.decidedBy?.kind === 'member' ? v.decidedBy.user : null);

/**
 * The deciders the form can name who are on no member list (they have left the organisation), so the Decided by field can
 * offer them and the conflict view and the who and when line can name them, labelled "(former member)". The page lists
 * current members only, so such a person's name comes from a version that names them: the current version the form knows
 * (`data.current`), and `opened`, the member decider of the version the form's answer was last opened from. The second keeps
 * the person's own decider named after a newer version by someone else has become the current one; without it the field
 * showed "Choose one" while a Save still posted that person. A name for an account id says nothing about which version is
 * current: the form drawn again from the current version ("Discard my version") opens from it, and the older one's decider goes.
 */
export function departedDeciders(data: Pick<QuestionPanelData, 'current' | 'members' | 'viewer'>, opened: NamedAccount | null): NamedAccount[] {
  const current = memberDecider(data.current);
  return [current, opened?.userId === current?.userId ? null : opened]
    .filter((u): u is NamedAccount => u !== null && u.userId !== data.viewer.userId && !data.members.some((m) => m.userId === u.userId));
}
