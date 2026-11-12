import type { ReactElement } from 'react';
import { formatDay } from '@/lib/format/dates';
import type { AgreementView } from '@/types/api';

/**
 * S-24's earlier agreement records (FR-ORG-05; W-10 note 4), kept as history: no route records a new one, and the
 * platform no longer reads one for anything. A read-only list, newest first, in the line format the screen always
 * used; no button, no form, no link. An organisation with none shows nothing.
 */
export function AgreementRecords({ agreements }: { agreements: readonly AgreementView[] }): ReactElement | null {
  if (agreements.length === 0) return null;
  return (
    <section aria-labelledby="earlier-agreements-heading">
      <h2 id="earlier-agreements-heading">Earlier agreement records (no longer used)</h2>
      <ul>
        {agreements.map((a) => (
          <li key={a.id}>
            {`v${a.agreementVersion} · accepted ${formatDay(a.acceptedOn)} · controller ${a.controllerLegalName} · ${a.dpContactEmail} · recorded on ${formatDay(a.recordedAt, 'Africa/Kampala')}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
