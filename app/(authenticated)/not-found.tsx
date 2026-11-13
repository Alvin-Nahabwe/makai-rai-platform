import type { Metadata } from 'next';
import { ERRORS_COPY } from '@/lib/errors/copy';
import { pageTitle } from '@/lib/ui/title';
import NotFoundCard from '@/components/layout/NotFoundCard';

export const metadata: Metadata = { title: pageTitle(ERRORS_COPY.titles.notFound) };

/**
 * S-31 for the signed-in group (SRS 7.1.5; UX-05; M-27). A notFound() thrown below app/(authenticated)/layout.tsx — today
 * orgs/[slug]/layout.tsx, for an organisation the person is not in or that does not exist — renders this file inside that layout.
 * The layout already supplies the one main landmark, the sidebar, the idle warning and the footer's place, so this page adds
 * none of them: only the card both S-31 pages share. It takes no props and reads nothing from the request (no headers, no
 * cookies, no params), so the words are the same for a missing record and for an organisation that exists but is not the
 * person's (UX-05). The sidebar beside it is built from the person's own memberships, so the address gets no role there.
 *
 * An address that matches no route, and a notFound() outside this group, are served by app/not-found.tsx.
 */
export default function NotFoundInGroup() {
  return <NotFoundCard />;
}
