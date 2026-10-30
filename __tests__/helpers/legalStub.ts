import { createHash } from 'node:crypto';
import { ACCEPTED_KINDS, CONSENT_TYPE_FOR, type AcceptedKind, type LegalTextKind, type LegalTextVersion } from '@/types/legal';

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** Version 1 of each accepted kind, for tests only. Nothing under app, lib or components imports this file. */
export const STUB_LEGAL_TEXTS: readonly LegalTextVersion[] = ACCEPTED_KINDS.map((kind): LegalTextVersion => {
  const text = `Stub ${kind} v1 for tests only.`;
  return { kind, version: '1', publishedOn: '2026-10-30', acceptance: 'required', sha256: sha256Hex(text), text };
});

/** The legal texts a fixture account accepts. Once the registry exists it reads from it; the shape stays. */
export function fixtureLegalTexts(): readonly LegalTextVersion[] {
  return STUB_LEGAL_TEXTS;
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
