import type { ReactElement } from 'react';
import type { IssuedDocumentView } from '@/types/api';
import { DOCUMENTS_COPY, DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { formatSize } from '@/lib/format/size';
import { formatFingerprint } from '@/lib/seal/format';
import { DocumentActions } from './DocumentActions';
import { NO_DOCUMENTS_LINE } from './GenerateDocumentForm';
import './Documents.css';

/**
 * The documents issued from one review, newest first (S-18, W-9; FR-DOC-04, M-35). Each line names the type, the seal it came
 * from, the issue date, who issued it and the SHA-256 in groups of four; the download shows its size (UX-20). A document made from
 * an older seal says "A later seal exists"; a withdrawn one says so with its reason; one whose bytes the operator erased has no
 * download. The reason is team text and is shown as text. "Copy as text" and "Withdraw" are DOC-b's slot.
 */
const L = DOCUMENTS_COPY.list;

export function IssuedDocumentsList({ orgSlug, documents, latestSealNumber, canWithdraw }: {
  orgSlug: string; documents: IssuedDocumentView[]; latestSealNumber: number | null; canWithdraw: boolean;
}): ReactElement {
  if (documents.length === 0) return <p className="documents-note">{NO_DOCUMENTS_LINE}</p>;
  return (
    <ul className="documents-issued">
      {documents.map((d) => {
        const home = d.seals[0];
        return (
          <li key={d.id}>
            <p className="documents-issued__title">{L.line(DOCUMENT_TITLES[d.documentType], home.sealNumber, formatUtcDay(d.issuedAt), d.issuedBy.name, formatFingerprint(d.sha256, 'short'))}</p>
            {latestSealNumber !== null && home.sealNumber < latestSealNumber ? <p className="documents-issued__meta">{L.olderSeal}</p> : null}
            {d.withdrawn !== null ? <p className="documents-issued__meta">{L.withdrawn(formatUtcDay(d.withdrawn.on), d.withdrawn.reason)}</p> : null}
            {d.erased !== null
              ? <p className="documents-issued__meta">{L.erased(formatUtcDay(d.erased.erasedOn))}</p>
              : <p>{d.withdrawn === null ? L.issuedWord : ''}<a href={`/api/v1/orgs/${encodeURIComponent(orgSlug)}/documents/${encodeURIComponent(d.id)}/pdf`}>{DOCUMENTS_COPY.issued.download(formatSize(d.byteSize))}</a></p>}
            <DocumentActions orgSlug={orgSlug} document={d} canWithdraw={canWithdraw} />
          </li>
        );
      })}
    </ul>
  );
}
