import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { LegalTextKind } from '@/types/legal';
import { RETIRED_NOTE, isRetiredKind } from '@/lib/legal/kinds';
import { LEGAL_PAGE_COPY } from '@/lib/legal/copy';
import { LEGAL_KINDS, currentLegalText, legalKindFrom, legalTextHistory } from '@/lib/legal/registry';
import { pageTitle } from '@/lib/ui/title';
import { Callout } from '@/components/ui/Callout';
import { LEGAL_LINK_STYLE, LEGAL_PAGE_STYLE, LegalTextView, legalTextHeading, versionLine } from '@/components/legal/LegalTextView';

/**
 * S-06, one kind (FR-ACC-02, SRS line 479): the current version of the text and the list of its past versions, which
 * is not shown when there are none; public (no `requireIdentity`). Every kind is rendered at build from the registry,
 * and any other `[kind]` is a 404 (`dynamicParams = false`, node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/
 * 02-route-segment-config/dynamicParams.md). The page also answers 404 itself for a kind the registry does not
 * hold, so a request's segment never reaches a file path or an object key (obligation A15).
 */

export const dynamicParams = false;

export function generateStaticParams(): Array<{ kind: LegalTextKind }> {
  return LEGAL_KINDS.map((kind) => ({ kind }));
}

type Params = Promise<{ kind: string }>;

async function kindOf(params: Params): Promise<LegalTextKind> {
  const kind = legalKindFrom((await params).kind);
  if (kind === null) notFound();
  return kind;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  return { title: pageTitle(legalTextHeading(await kindOf(params))) };
}

export default async function LegalKindPage({ params }: { params: Params }) {
  const kind = await kindOf(params);
  const current = currentLegalText(kind);
  // Oldest first in the registry; the list reads newest first, without the current version.
  const past = legalTextHistory(kind).slice(0, -1).reverse();
  return (
    <div style={LEGAL_PAGE_STYLE}>
      {isRetiredKind(kind) && (
        <div role="note">
          <Callout kind="note">{RETIRED_NOTE[kind]}</Callout>
        </div>
      )}
      <LegalTextView text={current} />
      <p style={{ marginTop: 'var(--space-6)' }}>
        <Link href={`/legal/${kind}/${current.version}`} style={LEGAL_LINK_STYLE}>
          {LEGAL_PAGE_COPY.linkToVersion(current.version)}
        </Link>{' '}
        {LEGAL_PAGE_COPY.textWillNotChange}
      </p>
      {past.length > 0 && (
        <section style={{ marginTop: 'var(--space-8)' }}>
          <h2>{LEGAL_PAGE_COPY.pastVersions}</h2>
          <ul style={{ listStyle: 'none', padding: 0, marginTop: 'var(--space-2)' }}>
            {past.map((text) => (
              <li key={text.version}>
                <Link href={`/legal/${kind}/${text.version}`} style={LEGAL_LINK_STYLE}>
                  {versionLine(text)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
