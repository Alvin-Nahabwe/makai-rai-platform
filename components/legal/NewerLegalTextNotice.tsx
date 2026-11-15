import type { ReactElement } from 'react';
import { offeredAcceptances } from '@/lib/data/acceptances';
import { LEGAL_KIND_NAMES } from '@/lib/legal/kinds';
import { NewerLegalTextOffers } from './NewerLegalTextOffers';

export type NewerLegalTextNoticeProps = { userId: string };

/**
 * The non-blocking offer of a newer legal text (M-39, SRS 7.1.2; FR-ACC-04), first inside `main` on every signed-in page.
 * An async server component that ACC-a fills by calling its own `offeredAcceptances(userId)`, so the shell calls no ACC-a
 * service. A slot of the shell (contract "Screens and slots"): UI renders it, ACC-a fills it. Null when nothing is
 * offered; otherwise one notice per offered text (the client half, NewerLegalTextOffers, keeps Not now).
 */
export async function NewerLegalTextNotice({ userId }: NewerLegalTextNoticeProps): Promise<ReactElement | null> {
  const offered = await offeredAcceptances(userId);
  if (offered.length === 0) return null;
  // Only what the notice shows crosses to the client: the text's name, version and date, no words of any text, no hash. offeredAcceptances never offers
  // the organisation agreement (it maps over ACCEPTED_KINDS); the filter only narrows LegalTextKind to AcceptedKind.
  const offers = offered.flatMap((t) => (t.kind === 'organisation-agreement' ? [] : [{ kind: t.kind, name: LEGAL_KIND_NAMES[t.kind], version: t.version, publishedOn: t.publishedOn }]));
  return <NewerLegalTextOffers userId={userId} offers={offers} />;
}
