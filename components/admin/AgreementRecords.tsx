import type { ReactElement } from 'react';
import { formatDay } from '@/lib/format/dates';
import type { AgreementView } from '@/types/api';
import './AdminForms.css';

/**
 * S-24's earlier agreement records (FR-ORG-05; W-10 note 4), kept as history: no route records a new one, and the
 * platform no longer reads one for anything. A read-only list, newest first, in the line format the screen always
 * used; no button, no form, no link. An organisation with none shows nothing. Its heading and line stay here, word for
 * word, out of the copy modules (coordinator's answer Q5 of 14 November 2026: the vocabulary lint refuses their retired
 * words, and they are history); plan 1A Task 19 restyled the block only.
 */
export function AgreementRecords({ agreements }: { agreements: readonly AgreementView[] }): ReactElement | null {
  if (agreements.length === 0) return null;
  return (
    <section aria-labelledby="earlier-agreements-heading" className="admin-block">
      <h2 id="earlier-agreements-heading">Earlier agreement records (no longer used)</h2>
      <ul className="admin-history">
        {agreements.map((a) => (
          <li key={a.id}>
            {`v${a.agreementVersion} · accepted ${formatDay(a.acceptedOn)} · controller ${a.controllerLegalName} · ${a.dpContactEmail} · recorded on ${formatDay(a.recordedAt, 'Africa/Kampala')}`}
          </li>
        ))}
      </ul>
    </section>
  );
}
