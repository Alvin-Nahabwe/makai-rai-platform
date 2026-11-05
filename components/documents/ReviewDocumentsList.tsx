import type { IssuedDocumentView } from '@/types/api';
import type { ReactElement } from 'react';
import { DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { formatFingerprint } from '@/lib/seal/format';

export type ReviewDocumentsListProps = { orgSlug: string; projectId: string; reviewId: string; documents: IssuedDocumentView[] };

/**
 * The documents issued from one stage review, a slot of S-16 (W-7; FR-DOC-01). Each line: type, the seal it came from, the issue
 * date and the short SHA-256, then "Withdrawn" or "Issued" in words, not colour (NFR-A11Y-05). The way to S-18 is the page's own
 * "Generate a document" link, shown to the roles that may generate; the slot adds no second one.
 */
export function ReviewDocumentsList({ documents }: ReviewDocumentsListProps): ReactElement | null {
  if (documents.length === 0) return null;
  return (
    <ul>
      {documents.map((d) => (
        <li key={d.id}>
          {`${DOCUMENT_TITLES[d.documentType]} . from seal ${d.seals[0].sealNumber} . issued ${formatUtcDay(d.issuedAt)} . SHA-256 ${formatFingerprint(d.sha256, 'short')} . ${d.withdrawn !== null ? 'Withdrawn' : 'Issued'}`}
        </li>
      ))}
    </ul>
  );
}
