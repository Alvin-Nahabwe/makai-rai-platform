import type { ReactElement } from 'react';
import type { IssuedDocumentView } from '@/types/api';
import { DOCUMENTS_COPY, DOCUMENT_TITLES, formatUtcDay } from '@/lib/documents/copy';
import { formatSize } from '@/lib/format/size';
import { formatFingerprint } from '@/lib/seal/format';
import { TERM_FINGERPRINT } from '@/lib/vocabulary/terms';
import { Definition, Term } from '@/components/ui/Definition';
import { DocumentActions } from './DocumentActions';
import { NO_DOCUMENTS_LINE } from './GenerateDocumentForm';
import './Documents.css';

/**
 * The documents issued from one review, newest first (S-18, W-9; FR-DOC-04, M-35). Each item names the type, then a description list
 * of the seal it came from, the issue date, who issued it and the short fingerprint (lane 6 row S9, C 318: a list of facts in place of a
 * line joined with " · "; the list of documents keeps its structure); the download shows its size (UX-20). The first item's
 * "Fingerprint" carries its definition (spec 6; ruling X-5: the list shows once, and only the issued notice above it can use the word
 * first). A document made from
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
      {documents.map((d, i) => {
        const home = d.seals[0];
        return (
          <li key={d.id}>
            <p className="documents-issued__title">{DOCUMENT_TITLES[d.documentType]}</p>
            <dl className="documents-issued__facts">
              <div><dt>{L.facts.seal}</dt><dd>{home.sealNumber}</dd></div>
              <div><dt>{L.facts.issuedOn}</dt><dd>{formatUtcDay(d.issuedAt)}</dd></div>
              <div><dt>{L.facts.issuedBy}</dt><dd>{d.issuedBy.name}</dd></div>
              <div>
                <dt>{i === 0 ? <Term of={TERM_FINGERPRINT}>{L.facts.fingerprint}</Term> : L.facts.fingerprint}</dt>
                <dd>{formatFingerprint(d.sha256, 'short')}{i === 0 ? <Definition of={TERM_FINGERPRINT} /> : null}</dd>
              </div>
            </dl>
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
