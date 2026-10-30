import type { LegalTextKind } from '@/types/legal';

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
