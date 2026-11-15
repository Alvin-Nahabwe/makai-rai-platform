import type { ReactElement } from 'react';
import { EvidenceItemText } from '@/components/evidence/EvidenceItemText';
import { publicOrigin } from '@/lib/publicOrigin';
import type { EvidenceItemView } from '@/types/api';
import './VersionEvidenceList.css';

/** The item renderer and the name rule now live in their own module (review A A3c-5); kept here for existing importers. */
export { EvidenceItemText, evidenceDisplayName } from '@/components/evidence/EvidenceItemText';

export type VersionEvidenceListProps = { orgSlug: string; items: EvidenceItemView[] };

/**
 * The platform's configured public origin, read on the SERVER (it reads AUTH_URL or NEXTAUTH_URL, which the browser does
 * not have), or null when none is configured: then no link is called the platform's own and every web link keeps "opens
 * another site" (coordinator, T3c item 8). A client tree is handed the value as a prop, never reads it itself, so the
 * server's render and the browser's agree.
 */
export function platformOrigin(): string | null {
  try {
    return publicOrigin();
  } catch {
    return null; // No origin configured: nothing is "own", the warning stays on every link.
  }
}

/**
 * The evidence of one decision version, with the erased label (FR-EVD-05). A slot of its screen (contract "Screens and
 * slots"): the screen's owner renders it, EVD fills it.
 */
export function VersionEvidenceList({ orgSlug, items }: VersionEvidenceListProps): ReactElement | null {
  if (items.length === 0) return null;
  const ownOrigin = platformOrigin();
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}><EvidenceItemText orgSlug={orgSlug} item={item} ownOrigin={ownOrigin} /></li>
      ))}
    </ul>
  );
}
