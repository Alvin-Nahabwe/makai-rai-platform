import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireIdentity } from '@/lib/auth/identity';
import { acceptanceChanges } from '@/lib/data/acceptances';
import { AcceptancesView } from '@/components/legal/AcceptancesView';
import { GateFrame, type GateStop } from '@/components/layout/GateFrame';
import { LEGAL_COPY } from '@/lib/legal/copy';
import { GATE_COPY } from '@/lib/shell/copy';
import { pageTitle } from '@/lib/ui/title';

export const metadata: Metadata = { title: pageTitle(LEGAL_COPY.titles.acceptances) };

/** Reached signed in, by gate 3 or by M-39's Read and accept; the next step depends on the account, so none is named. */
const ROUTE: readonly GateStop[] = [
  { label: GATE_COPY.stops.signIn, state: 'done' },
  { label: GATE_COPY.stops.accept, state: 'current' },
];

/**
 * S-05 (FR-ACC-03, FR-ACC-04, UX-22): the texts this account must accept before any other page,
 * gate 3 of SRS 7.1.2 sends it here; else a newer version it may accept (mode `offer`, from
 * M-39's Read and accept); else nothing to do, so home (S-07). Exempt from gate 3 by its exact
 * path (lib/auth/identity.ts, ACCEPTANCE_EXEMPT_PATHS). In the gate frame's wide card since plan 1B Task 1. Since plan 1B
 * Task 7 each text accepted before at an older version says what changed (AcceptancesView). The mode is as before: required
 * when any text is missing, and then only the missing ones are shown; else the offered ones.
 */
export default async function AcceptancesPage() {
  const identity = await requireIdentity();
  const changes = await acceptanceChanges(identity.userId);
  const missing = changes.filter((c) => c.state === 'missing');
  const mode = missing.length > 0 ? 'required' : 'offer';
  const shown = mode === 'required' ? missing : changes;
  if (shown.length === 0) redirect('/');
  // The form shows each text's version and date, links its words on S-06 and posts only kind and version, so the words
  // stay on the server: serialised props reach the client payload (S-04 does the same, invitations/[token]/page.tsx).
  const items = shown.map((c) => ({ ...c, current: { ...c.current, text: '' } }));
  return (
    <GateFrame variant="signed-in" userName={identity.name ?? ''} userId={identity.userId} accountReachable route={ROUTE} wide>
      <AcceptancesView items={items} mode={mode} userId={identity.userId} />
    </GateFrame>
  );
}
