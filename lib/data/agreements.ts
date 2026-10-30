/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgContext } from '@/lib/data/tenant';
import type { AgreementView } from '@/types/api';

/** The organisation's latest agreement row on the tenant lane (FR-ORG-05, S-30). Typed stub until the producer merges. */

// CONTRACT_STUB: ORG
export async function currentAgreement(ctx: OrgContext): Promise<AgreementView | null> {
  return null;
}
