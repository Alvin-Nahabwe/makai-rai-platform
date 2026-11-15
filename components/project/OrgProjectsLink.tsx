'use client';

import { useParams } from 'next/navigation';
import type { ReactElement } from 'react';
import { ListLink } from '@/components/ui/ListLink';

/**
 * `children` as a link to the organisation's projects list (`/orgs/<slug>/projects`), the slug read from the address:
 * every page that shows the archived banner is under `/orgs/[slug]/…`, so the banner needs no prop from its ~12 callers.
 * Outside such an address (no slug) the words stay plain text rather than a link to a wrong place.
 */
export function OrgProjectsLink({ children }: { children: string }): ReactElement {
  const params = useParams<{ slug?: string }>();
  const slug = typeof params?.slug === 'string' ? params.slug : null;
  if (slug === null) return <>{children}</>;
  return <ListLink href={`/orgs/${encodeURIComponent(slug)}/projects`}>{children}</ListLink>;
}
