import { createHash } from 'node:crypto';
import { currentLegalText } from '@/lib/legal/registry';
import { ACCEPTED_KINDS, CONSENT_TYPE_FOR, type AcceptedKind, type LegalTextKind, type LegalTextVersion } from '@/types/legal';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Version 1 of each accepted kind, for tests only. Nothing under app, lib or components imports this file. */
export const STUB_LEGAL_TEXTS: readonly LegalTextVersion[] = ACCEPTED_KINDS.map((kind): LegalTextVersion => {
  const text = `Stub ${kind} v1 for tests only.`;
  return { kind, version: '1', publishedOn: '2026-10-30', acceptance: 'required', sha256: sha256Hex(text), text };
});

/**
 * The legal texts a fixture account accepts: the registry's current version of each accepted kind.
 * Under vitest, __tests__/setup/legal.ts mocks the registry with STUB_LEGAL_TEXTS, so this is
 * STUB_LEGAL_TEXTS there; in a Playwright process, which has no vi.mock, it is the real registry's
 * texts, so the e2e fixture accounts pass the real gate (00-contract.md, Test harness API).
 */
export function fixtureLegalTexts(): readonly LegalTextVersion[] {
  return ACCEPTED_KINDS.map((k) => currentLegalText(k));
}

function isAcceptedKind(kind: LegalTextKind): kind is AcceptedKind {
  return kind in CONSENT_TYPE_FOR;
}

/** The `consent_records` rows a fixture account holds for `fixtureLegalTexts()`. */
export function stubAcceptanceRows(userId: string): Array<{
  userId: string;
  consentType: 'terms_of_service' | 'privacy_policy' | 'cross_border_storage';
  version: string;
  textHash: string;
  granted: true;
}> {
  return fixtureLegalTexts().flatMap((t) => (
    isAcceptedKind(t.kind)
      ? [{ userId, consentType: CONSENT_TYPE_FOR[t.kind], version: t.version, textHash: t.sha256, granted: true as const }]
      : []
  ));
}
