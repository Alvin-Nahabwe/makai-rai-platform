import type { IssuedDocumentView } from '@/types/api';
import type { ReactElement } from 'react';
import { DOCUMENTS_COPY, DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { formatSize } from '@/lib/format/size';
import { formatFingerprint } from '@/lib/seal/format';

export type ReviewDocumentsListProps = { orgSlug: string; projectId: string; reviewId: string; documents: IssuedDocumentView[] };

/**
 * The documents issued from one stage review, a slot of S-16 (W-7; FR-DOC-01). Each line: type, the seal it came from, the issue
 * date and the short fingerprint, then "Withdrawn" or "Issued" in words, not colour (NFR-A11Y-05), then the link to its PDF under the
 * rule of S-18's own list (IssuedDocumentsList): the same address and words, and no link once the operator erased the bytes (the
 * route answers 410). Every member reads this page and the route asks `record:read` alone, so every role that sees a line gets
 * its link; a withdrawn document's bytes are still served. The way to S-18 is the page's own "Create a document" link, shown to
 * the roles that may generate; the slot adds no second one.
 */
export function ReviewDocumentsList({ orgSlug, documents }: ReviewDocumentsListProps): ReactElement | null {
  if (documents.length === 0) return null;
  return (
    <ul>
      {documents.map((d) => (
        <li key={d.id}>
          {DOCUMENTS_COPY.list.reviewLine(DOCUMENT_TITLES[d.documentType], d.seals[0].sealNumber, formatUtcDay(d.issuedAt), formatFingerprint(d.sha256, 'short'), d.withdrawn !== null)}
          {d.erased !== null ? null : (
            <> <a href={`/api/v1/orgs/${encodeURIComponent(orgSlug)}/documents/${encodeURIComponent(d.id)}/pdf`}>{DOCUMENTS_COPY.issued.download(formatSize(d.byteSize))}</a></>
          )}
        </li>
      ))}
    </ul>
  );
}
