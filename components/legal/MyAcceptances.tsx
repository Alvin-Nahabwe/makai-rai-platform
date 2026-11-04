import type { CSSProperties, ReactElement } from 'react';
import { myAcceptances, offeredAcceptances } from '@/lib/data/acceptances';
import { formatDay } from '@/lib/format/dates';
import { LEGAL_KIND_NAMES } from '@/lib/legal/kinds';

export type MyAcceptancesProps = { userId: string };

const LINK: CSSProperties = { display: 'inline-block', minHeight: '24px', minWidth: '24px' };
const capitalised = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The legal texts the account has accepted, on the account page (S-21, W-12 note 2; FR-ACC-03, FR-ACC-04). An async server
 * component that calls ACC-a's own services, so ACC-b imports nothing from ACC-a. A slot of its screen (contract "Screens
 * and slots"): the screen's owner renders it, ACC-a fills it. Per kind: "<Name> v<version> · accepted <date> · [Read]",
 * and for a kind with a newer version offered "A newer version (v<version>) exists [Review]" to S-05. A read-only record:
 * no form control (7.4.2 row S-21).
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
            return (
              <li key={r.kind} style={{ marginBottom: 'var(--space-2)' }}>
                {`${capitalised(LEGAL_KIND_NAMES[r.kind])} v${r.version} · accepted ${formatDay(r.acceptedAt.slice(0, 10))} · `}
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
