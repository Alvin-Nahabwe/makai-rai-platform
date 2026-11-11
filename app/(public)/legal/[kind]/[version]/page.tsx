import type { CSSProperties } from 'react';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { LegalTextKind, LegalTextVersion } from '@/types/legal';
import { formatDay } from '@/lib/format/dates';
import {
  LEGAL_KINDS,
  LEGAL_KIND_NAMES,
  currentLegalText,
  legalKindFrom,
  legalTextHistory,
  legalTextVersion,
} from '@/lib/legal/registry';
import { RETIRED_NOTE, isRetiredKind } from '@/lib/legal/kinds';
import { LEGAL_LINK_STYLE, LEGAL_PAGE_STYLE, LegalTextView, legalTextHeading } from '@/components/legal/LegalTextView';

/**
 * S-06, one version (FR-ACC-02, SRS line 479: "/legal/privacy/<old-version>"): that version's text, version,
 * date and hash, at an address whose content never changes, public (no `requireIdentity`). Every (kind,
 * version) of the registry is rendered at build and any other pair is a 404 (`dynamicParams = false`); the page
 * also answers 404 itself for a pair the registry does not hold, so `[version]` is only ever compared with the
 * registry's own version strings and never builds a file path (obligation A15).
 */

export const dynamicParams = false;

/** The tinted band of S-06's notes (the same look as the earlier-version note of the version page). */
const NOTE_STYLE: CSSProperties = {
  padding: 'var(--space-3) var(--space-4)',
  background: 'var(--tint-moderate-bg)',
  color: 'var(--tint-moderate-fg)',
  borderRadius: 'var(--border-radius-sm)',
};

export function generateStaticParams(): Array<{ kind: LegalTextKind; version: string }> {
  return LEGAL_KINDS.flatMap((kind) => legalTextHistory(kind).map((text) => ({ kind, version: text.version })));
}

type Params = Promise<{ kind: string; version: string }>;

async function versionOf(params: Params): Promise<LegalTextVersion> {
  const { kind, version } = await params;
  const known = legalKindFrom(kind);
  const text = known === null ? null : legalTextVersion(known, version);
  if (text === null) notFound();
  return text;
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const text = await versionOf(params);
  return { title: `${legalTextHeading(text.kind)}, version ${text.version} - MAK-AI RAI Platform` };
}

export default async function LegalVersionPage({ params }: { params: Params }) {
  const text = await versionOf(params);
  const current = currentLegalText(text.kind);
  return (
    <div style={LEGAL_PAGE_STYLE}>
      {isRetiredKind(text.kind) ? (
        // The retired note says what matters about every version of the agreement, so it stands in for the earlier-version note.
        <p role="note" style={{ ...NOTE_STYLE, marginBottom: 'var(--space-6)' }}>
          {RETIRED_NOTE[text.kind]}
        </p>
      ) : (
        current.version !== text.version && (
          <p role="note" style={{ ...NOTE_STYLE, marginBottom: 'var(--space-6)' }}>
            {`This is an earlier version. The current one is version ${current.version}, published ${formatDay(current.publishedOn)}.`}
          </p>
        )
      )}
      <LegalTextView text={text} />
      <p style={{ marginTop: 'var(--space-6)' }}>
        <Link href={`/legal/${text.kind}`} style={LEGAL_LINK_STYLE}>
          {`All versions of the ${LEGAL_KIND_NAMES[text.kind]}`}
        </Link>
      </p>
    </div>
  );
}
