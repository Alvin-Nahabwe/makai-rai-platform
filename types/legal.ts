export type LegalTextKind = 'terms' | 'privacy' | 'cross-border-consent' | 'organisation-agreement';
/** The three an account accepts (FR-ACC-03); the agreement is recorded by the administrator. */
export const ACCEPTED_KINDS = ['terms', 'privacy', 'cross-border-consent'] as const;
export type AcceptedKind = (typeof ACCEPTED_KINDS)[number];
/** ConsentType value for each accepted kind (prisma enum ConsentType). */
export const CONSENT_TYPE_FOR: Record<AcceptedKind, 'terms_of_service' | 'privacy_policy' | 'cross_border_storage'> = {
  terms: 'terms_of_service', privacy: 'privacy_policy', 'cross-border-consent': 'cross_border_storage',
};
export interface LegalTextVersion {
  kind: LegalTextKind;
  version: string;
  publishedOn: string;
  acceptance: 'required' | 'offered';
  sha256: string;
  text: string;
}
export interface AcceptanceView { kind: AcceptedKind; version: string; sha256: string | null; acceptedAt: string }
