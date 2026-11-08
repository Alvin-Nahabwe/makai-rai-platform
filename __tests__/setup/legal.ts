import { createHash } from 'node:crypto';
import { vi } from 'vitest';
import type { LegalTextKind, LegalTextVersion } from '@/types/legal';

/**
 * Replaces the legal text registry (lib/legal/registry.ts) in every test file with the stub texts
 * of __tests__/helpers/legalStub.ts (00-contract.md, Test harness API): version '1' of terms,
 * privacy and cross-border-consent, plus a stub organisation-agreement of this file's own, so a
 * boot check that asks for all four kinds passes in the register() tests. Accounts that
 * buildOrg writes with `fixtureLegalTexts()` rows therefore pass the acceptance gate.
 *
 * The texts are built here by the formula of legalStub.ts rather than imported from it, because
 * legalStub.ts imports the registry this factory is making (importing it here deadlocks the
 * module loader); __tests__/integration/acceptance-gate.test.ts pins that the two agree. A test that needs the real registry or other versions declares its
 * own vi.mock of '@/lib/legal/registry', which replaces this one for that file.
 */
vi.mock('@/lib/legal/registry', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/legal/registry')>();
  const stub = (kind: LegalTextKind): LegalTextVersion => {
    const text = `Stub ${kind} v1 for tests only.`;
    return { kind, version: '1', publishedOn: '2026-10-30', acceptance: 'required', sha256: createHash('sha256').update(text, 'utf8').digest('hex'), text };
  };
  const texts = new Map<LegalTextKind, readonly LegalTextVersion[]>(real.LEGAL_KINDS.map((k) => [k, [stub(k)]]));
  const historyOf = (kind: LegalTextKind): readonly LegalTextVersion[] => {
    const history = texts.get(kind);
    if (history === undefined || history.length === 0) throw new Error(`no legal text of kind ${kind}`);
    return history;
  };
  return {
    ...real,
    currentLegalText: (kind: LegalTextKind) => historyOf(kind)[historyOf(kind).length - 1],
    legalTextVersion: (kind: LegalTextKind, version: string) => texts.get(kind)?.find((t) => t.version === version) ?? null,
    legalTextHistory: (kind: LegalTextKind) => [...historyOf(kind)],
  };
});
