import type { CSSProperties, ReactElement } from 'react';
import { myAcceptances, offeredAcceptances } from '@/lib/data/acceptances';
import { formatDay } from '@/lib/format/dates';
import { MY_ACCEPTANCES_COPY } from '@/lib/legal/copy';
import { legalTextVersion } from '@/lib/legal/registry';
import { legalTextHeading } from './LegalTextView';

export type MyAcceptancesProps = { userId: string };

const LINK: CSSProperties = { display: 'inline-block', minHeight: '24px', minWidth: '24px' };

/**
 * The legal texts the account has accepted, on the account page (S-21, W-12 note 2; FR-ACC-03, FR-ACC-04). An async server
 * component that calls ACC-a's own services, so ACC-b imports nothing from ACC-a. A slot of its screen (contract "Screens
 * and slots"): the screen's owner renders it, ACC-a fills it. Per kind: "<Name>, version <n>. Accepted on <date>. [Read]",
 * and for a kind with a newer version offered "Version <n> is now available. [Read and accept]" to S-05. A row that does not
 * count as an acceptance (its version and hash are no published text, as a v0.5.0 "1.0" row) reads "... This was an older
 * version. Accept the current version. [Read and accept]" to S-05, with no Read link (there is no such page). A read-only record: no form control (7.4.2 row S-21).
 */
export async function MyAcceptances({ userId }: MyAcceptancesProps): Promise<ReactElement | null> {
  const [rows, offered] = await Promise.all([myAcceptances(userId), offeredAcceptances(userId)]);
  return (
    <section aria-labelledby="my-acceptances-heading">
      <h2 id="my-acceptances-heading" style={{ marginBottom: 'var(--space-2)' }}>{MY_ACCEPTANCES_COPY.heading}</h2>
      {rows.length === 0 ? (
        <p>{MY_ACCEPTANCES_COPY.empty}</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((r) => {
            const newer = offered.find((t) => t.kind === r.kind);
            const line = MY_ACCEPTANCES_COPY.accepted(legalTextHeading(r.kind), r.version, formatDay(r.acceptedAt.slice(0, 10)));
            // The same rule as gate 3: a row counts only for a published text with that version and hash (lib/data/acceptances.ts).
            if (legalTextVersion(r.kind, r.version)?.sha256 !== r.sha256) {
              return (
                <li key={r.kind} style={{ marginBottom: 'var(--space-2)' }}>
                  {line} {MY_ACCEPTANCES_COPY.olderVersion}{' '}
                  <a href="/acceptances" style={LINK}>{MY_ACCEPTANCES_COPY.readAndAccept}</a>
                </li>
              );
            }
            return (
              <li key={r.kind} style={{ marginBottom: 'var(--space-2)' }}>
                {line}{' '}
                <a href={`/legal/${r.kind}/${encodeURIComponent(r.version)}`} style={LINK}>{MY_ACCEPTANCES_COPY.read}</a>
                {newer !== undefined && (
                  <>
                    {' '}{MY_ACCEPTANCES_COPY.newerAvailable(newer.version)}{' '}
                    <a href="/acceptances" style={LINK}>{MY_ACCEPTANCES_COPY.readAndAccept}</a>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
