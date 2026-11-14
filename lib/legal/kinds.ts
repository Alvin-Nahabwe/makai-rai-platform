import { ACCEPTED_KINDS, type AcceptedKind, type LegalTextKind } from '@/types/legal';
import { ACCEPTANCES_COPY } from '@/lib/legal/acceptances/copy';

/**
 * The four kinds of legal text and their names in running text (SRS 7.5.7, M-25 and M-39). Kept
 * apart from lib/legal/registry.ts, which reads data/legal from disk when it loads, so a client
 * component (S-05's form, the newer-text notice) can name a kind without bundling node:fs.
 * registry.ts re-exports both.
 */
export const LEGAL_KINDS: readonly LegalTextKind[] = ['terms', 'privacy', 'cross-border-consent', 'organisation-agreement'];

export const LEGAL_KIND_NAMES: Record<LegalTextKind, string> = {
  terms: 'terms of service',
  privacy: 'privacy notice',
  'cross-border-consent': 'consent to storage abroad',
  'organisation-agreement': 'organisation agreement',
};

/**
 * Kinds whose text is kept as history and no longer asked for: nobody is asked to accept one and no screen records it.
 * The organisation agreement is the only one; its page says so (S-06, FR-ACC-02).
 */
export const RETIRED_KINDS = ['organisation-agreement'] as const;
export type RetiredKind = (typeof RETIRED_KINDS)[number];

/** The line S-06 shows above a retired kind's text. It holds no link and names no section of the terms, so it is true whichever version of the terms is current. */
export const RETIRED_NOTE: Record<RetiredKind, string> = {
  'organisation-agreement': 'This agreement is no longer used. MAK-AI does not ask organisations to sign it.',
};

export function isRetiredKind(kind: LegalTextKind): kind is RetiredKind {
  return (RETIRED_KINDS as readonly LegalTextKind[]).includes(kind);
}

/** One acceptance as S-04 and S-05 post it to routes 30 and 31: the kind and the version the person was shown (threat A5). */
export interface AcceptancePair { kind: AcceptedKind; version: string }

/**
 * Routes 30 and 31's one reading of a posted `acceptances` (C4 SI-3): a list of `{ kind, version }`
 * with `kind` one of the three accepted kinds and `version` a string. Anything else, the old
 * list of bare kinds included, is not.
 */
export function isAcceptancePairs(value: unknown): value is AcceptancePair[] {
  return Array.isArray(value) && value.every((a: unknown) => {
    if (typeof a !== 'object' || a === null) return false;
    const { kind, version } = a as { kind?: unknown; version?: unknown };
    return typeof kind === 'string' && (ACCEPTED_KINDS as readonly string[]).includes(kind) && typeof version === 'string';
  });
}

/** M-25 (SRS 7.5.7) for one text: "Tick the box for the <name>." S-04, S-05 and route 31 say it the same way; the words are in the acceptances copy module. */
export function acceptanceError(kind: AcceptedKind): string {
  return ACCEPTANCES_COPY.tickBoxFor(LEGAL_KIND_NAMES[kind]);
}
