import Link from 'next/link';
import type { CSSProperties, ReactElement } from 'react';
import { ORG_COPY } from '@/lib/org/copy';

/** A target of at least 24 by 24 px (WCAG 2.5.8, UX-34), as AccountRegions' links. */
const TARGET: CSSProperties = { display: 'inline-block', minWidth: '24px', minHeight: '24px' };

export type TeamExportLinkProps = { orgSlug: string; canExport: boolean };

/**
 * The link from the organisation page (S-30) to the team export of the whole organisation (S-20,
 * FR-EXP-01). Owners and admins only (`team:export`); nothing for anyone else. A slot of S-30
 * (contract "Screens and slots"): MEM's page renders it, EXP fills it.
 */
export function TeamExportLink({ orgSlug, canExport }: TeamExportLinkProps): ReactElement | null {
  if (!canExport) return null;
  return <p><Link href={`/orgs/${orgSlug}/export`} style={TARGET}>{ORG_COPY.organisation.download}</Link></p>;
}
