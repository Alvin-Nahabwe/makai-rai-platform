import type { ReactElement } from 'react';

export type NewerLegalTextNoticeProps = { userId: string };

/**
 * The non-blocking offer of a newer legal text (M-39, SRS 7.1.2), first inside `main` on every signed-in page. An async server
 * component that ACC-a fills by calling its own `offeredAcceptances(userId)`, so the shell calls no ACC-a service. A slot of the
 * shell (contract "Screens and slots"): UI renders it, ACC-a fills it.
 */
// SLOT_STUB: ACC-a
export async function NewerLegalTextNotice(_props: NewerLegalTextNoticeProps): Promise<ReactElement | null> {
  return null;
}
