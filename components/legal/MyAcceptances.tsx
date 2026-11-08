import type { CSSProperties, ReactElement } from 'react';
import { myAcceptances, offeredAcceptances } from '@/lib/data/acceptances';
import { formatDay } from '@/lib/format/dates';
import { legalTextVersion } from '@/lib/legal/registry';
import { legalTextHeading } from './LegalTextView';

export type MyAcceptancesProps = { userId: string };

const LINK: CSSProperties = { display: 'inline-block', minHeight: '24px', minWidth: '24px' };

/**
 * The legal texts the account has accepted, on the account page (S-21, W-12 note 2; FR-ACC-03, FR-ACC-04). An async server
 * component that calls ACC-a's own services, so ACC-b imports nothing from ACC-a. A slot of its screen (contract "Screens
 * and slots"): the screen's owner renders it, ACC-a fills it. Per kind: "<Name> v<version> · accepted <date> · [Read]",
 * and for a kind with a newer version offered "A newer version (v<version>) exists [Review]" to S-05. A row that does not
 * count as an acceptance (its version and hash are no published text, as a v0.5.0 "1.0" row) reads "... · no longer
 * counts · [Review]" to S-05, with no Read link (there is no such page). A read-only record: no form control (7.4.2 row S-21).
 */
export async function MyAcceptances({ userId }: MyAcceptancesProps): Promise<ReactElement | null> {
  const [rows, offered] = await Promise.all([myAcceptances(userId), offeredAcceptances(userId)]);
  return (
    <section aria-labelledby="my-acceptances-heading">
      <h2 id="my-acceptances-heading">What I have accepted</h2>
      {rows.length === 0 ? (
        <p>No acceptance is recorded for this account.</p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map((r) => {
            const newer = offered.find((t) => t.kind === r.kind);
            const line = `${legalTextHeading(r.kind)} v${r.version} · accepted ${formatDay(r.acceptedAt.slice(0, 10))} · `;
            // The same rule as gate 3: a row counts only for a published text with that version and hash (lib/data/acceptances.ts).
            if (legalTextVersion(r.kind, r.version)?.sha256 !== r.sha256) {
              return (
                <li key={r.kind} style={{ marginBottom: 'var(--space-2)' }}>
                  {`${line}no longer counts · `}
                  <a href="/acceptances" style={LINK}>Review</a>
                </li>
              );
            }
            return (
              <li key={r.kind} style={{ marginBottom: 'var(--space-2)' }}>
                {line}
                <a href={`/legal/${r.kind}/${encodeURIComponent(r.version)}`} style={LINK}>Read</a>
                {newer !== undefined && (
                  <>
                    {`   A newer version (v${newer.version}) exists `}
                    <a href="/acceptances" style={LINK}>Review</a>
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
