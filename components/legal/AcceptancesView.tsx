import type { ReactElement, ReactNode } from 'react';
import { RecordAcceptances } from '@/components/legal/RecordAcceptances';
import type { AcceptanceChange } from '@/lib/data/acceptances';
import { ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';
import { LEGAL_CHANGE_SUMMARIES, LEGAL_COPY } from '@/lib/legal/copy';
import { LEGAL_KIND_NAMES } from '@/lib/legal/kinds';
import { legalTextHistory } from '@/lib/legal/registry';
import type { AcceptedKind } from '@/types/legal';
import './AcceptancesView.css';

/**
 * The summaries of every version after the one the person accepted, up to the current one, in published order: a person
 * two versions behind is told what changed in each. A version with no summary (legal-change-summaries.test.ts requires
 * one for every published version after 1, so none should ship) is left out and named in one server line, never thrown:
 * S-05 is the only way through gate 3, so a throw here would lock the account out.
 */
function summariesSince(kind: AcceptedKind, lastAccepted: string, current: string): string[] {
  const versions = legalTextHistory(kind).map((t) => t.version);
  const after = versions.slice(versions.indexOf(lastAccepted) + 1, versions.indexOf(current) + 1);
  return after.flatMap((version) => {
    const summary = LEGAL_CHANGE_SUMMARIES[kind][version];
    if (summary === undefined) {
      console.error('legal_change_summary_missing', kind, version);
      return [];
    }
    return [summary];
  });
}

/** Which text changed, from which version to which, what changed, and a link to its full words (spec 9.8). */
function ChangeSummary({ item }: { item: AcceptanceChange & { lastAccepted: string } }): ReactElement {
  const name = LEGAL_KIND_NAMES[item.kind];
  const summaries = summariesSince(item.kind, item.lastAccepted, item.current.version);
  return (
    <div className="acceptance-change">
      <h2 className="acceptance-change__title">{LEGAL_COPY.changes.title(name, item.lastAccepted, item.current.version)}</h2>
      {summaries.length > 0 ? (
        <>
          <h3 className="acceptance-change__label">{LEGAL_COPY.changes.whatChanged}</h3>
          {summaries.map((summary) => <p key={summary} className="acceptance-change__summary">{summary}</p>)}
        </>
      ) : null}
      <a className="acceptance-change__link" href={`/legal/${item.kind}/${item.current.version}`} target="_blank" rel="noopener">
        {LEGAL_COPY.changes.readFull(name)}<span>{' '}{ACCEPTANCES_COPY.opensInNewTab}</span>
      </a>
    </div>
  );
}

/**
 * S-05's body (plan 1B Task 7; spec 9.8): the texts the person must accept (mode `required`) or may accept (`offer`), each
 * with its box. A text accepted before at an older version first says which text changed, from which version to which,
 * the plain summary of what changed (LEGAL_CHANGE_SUMMARIES, owner-approved, server-only), and links its full words; a
 * first acceptance shows none of that. When a required text changed, the heading is "The terms have changed". Each text's
 * words are stripped before anything reaches the client (stage 0 Task 4; T7.3): the form posts only kind and version.
 * A version with no summary still names the text and its versions and links its words, so the person can read and accept.
 */
export function AcceptancesView({ items, mode, userId }: { items: readonly AcceptanceChange[]; mode: 'required' | 'offer'; userId: string }): ReactElement {
  const texts = items.map((i) => ({ ...i.current, text: '' }));
  const before: Partial<Record<AcceptedKind, ReactNode>> = {};
  for (const item of items) {
    if (item.lastAccepted !== null) before[item.kind] = <ChangeSummary item={{ ...item, lastAccepted: item.lastAccepted }} />;
  }
  const heading = mode === 'required' && items.some((i) => i.lastAccepted !== null) ? LEGAL_COPY.changes.heading : undefined;
  return <RecordAcceptances texts={texts} mode={mode} userId={userId} heading={heading} before={before} />;
}
