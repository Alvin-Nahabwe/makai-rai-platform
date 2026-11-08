import type { ReactElement } from 'react';
import type { IssuedDocumentView } from '@/types/api';
import { DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { formatSize } from '@/lib/format/size';
import { formatFingerprint } from '@/lib/seal/format';
import { DocumentActions } from './DocumentActions';
import { NO_DOCUMENTS_LINE } from './GenerateDocumentForm';

/**
 * The documents issued from one review, newest first (S-18, W-9; FR-DOC-04, M-35). Each line names the type, the seal it came
 * from, the issue date, who issued it and the SHA-256 in groups of four; the download shows its size (UX-20). A document made from
 * an older seal says "A later seal exists"; a withdrawn one says so with its reason; one whose bytes the operator erased has no
 * download. The reason is team text and is shown as text. "Copy as text" and "Withdraw" are DOC-b's slot.
 */
export function IssuedDocumentsList({ orgSlug, documents, latestSealNumber, canWithdraw }: {
  orgSlug: string; documents: IssuedDocumentView[]; latestSealNumber: number | null; canWithdraw: boolean;
}): ReactElement {
  if (documents.length === 0) return <p>{NO_DOCUMENTS_LINE}</p>;
  return (
    <ul>
      {documents.map((d) => {
        const home = d.seals[0];
        return (
          <li key={d.id}>
            <p>{`${DOCUMENT_TITLES[d.documentType]} . seal ${home.sealNumber} . ${formatUtcDay(d.issuedAt)} . by ${d.issuedBy.name} . SHA-256 ${formatFingerprint(d.sha256, 'short')}`}</p>
            {latestSealNumber !== null && home.sealNumber < latestSealNumber ? <p>A later seal exists</p> : null}
            {d.withdrawn !== null ? <p>{`Withdrawn on ${formatUtcDay(d.withdrawn.on)}: ${d.withdrawn.reason}`}</p> : null}
            {d.erased !== null
              ? <p>{`Erased on ${formatUtcDay(d.erased.erasedOn)}`}</p>
              : <p>{d.withdrawn === null ? 'Issued ' : ''}<a href={`/api/v1/orgs/${encodeURIComponent(orgSlug)}/documents/${encodeURIComponent(d.id)}/pdf`}>{`Download PDF (${formatSize(d.byteSize)})`}</a></p>}
            <DocumentActions orgSlug={orgSlug} document={d} canWithdraw={canWithdraw} />
          </li>
        );
      })}
    </ul>
  );
}
