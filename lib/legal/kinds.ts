import { ACCEPTED_KINDS, type AcceptedKind, type LegalTextKind } from '@/types/legal';

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
  'cross-border-consent': 'cross-border storage consent',
  'organisation-agreement': 'organisation agreement',
};

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

/** M-25 (SRS 7.5.7) for one text: "To continue, accept the <name>." S-04, S-05 and route 31 say it the same way. */
export function acceptanceError(kind: AcceptedKind): string {
  return `To continue, accept the ${LEGAL_KIND_NAMES[kind]}.`;
}
