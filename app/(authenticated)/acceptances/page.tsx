import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { missingAcceptances, offeredAcceptances } from '@/lib/data/acceptances';
import { currentLegalText } from '@/lib/legal/registry';
import { RecordAcceptances } from '@/components/legal/RecordAcceptances';
import { LEGAL_COPY } from '@/lib/legal/copy';
import { pageTitle } from '@/lib/ui/title';

export const metadata: Metadata = { title: pageTitle(LEGAL_COPY.titles.acceptances) };

/**
 * S-05 (FR-ACC-03, FR-ACC-04, UX-22): the texts this account must accept before any other page,
 * gate 3 of SRS 7.1.2 sends it here; else a newer version it may accept (mode `offer`, from
 * M-39's Read and accept); else nothing to do, so home (S-07). Exempt from gate 3 by its exact
 * path (lib/auth/identity.ts, ACCEPTANCE_EXEMPT_PATHS).
 */
export default async function AcceptancesPage() {
  const identity = await requireIdentity();
  const missing = await missingAcceptances(identity.userId);
  const shown = missing.length > 0 ? missing.map((k) => currentLegalText(k)) : await offeredAcceptances(identity.userId);
  // The form shows each text's version and date, links its words on S-06 and posts only kind and version, so the words
  // stay on the server: serialised props reach the client payload (S-04 does the same, invitations/[token]/page.tsx).
  const texts = shown.map((t) => ({ ...t, text: '' }));
  if (texts.length === 0) redirect('/');
  const mode = missing.length > 0 ? 'required' : 'offer';
  return (
    <div style={{ maxWidth: '40rem' }}>
      <RecordAcceptances texts={texts} mode={mode} userId={identity.userId} />
    </div>
  );
}
