import type { AgreementView } from '@/types/api';
import type { ReactElement } from 'react';
import { formatDay } from '@/lib/format/dates';

export type AgreementSummaryProps = { agreement: AgreementView | null };

/**
 * The organisation's current agreement, a slot of S-30 (SRS line 333: "current agreement version and date,
 * controller legal name, data-protection contact"; contract "Screens and slots": MEM renders the page, ORG
 * fills the slot). An organisation created before agreements were recorded has none and keeps working
 * (FR-ORG-06).
 */
export function AgreementSummary({ agreement }: AgreementSummaryProps): ReactElement {
  return (
    <section aria-labelledby="agreement-summary-heading">
      <h2 id="agreement-summary-heading">Organisation agreement</h2>
      {agreement === null ? (
        <p>No agreement recorded</p>
      ) : (
        <dl>
          <dt>Agreement version</dt>
          <dd>{agreement.agreementVersion}</dd>
          <dt>Accepted on</dt>
          <dd>{formatDay(agreement.acceptedOn)}</dd>
          <dt>Controller legal name</dt>
          <dd>{agreement.controllerLegalName}</dd>
          <dt>Data-protection contact</dt>
          <dd>{agreement.dpContactEmail}</dd>
        </dl>
      )}
    </section>
  );
}
