import type { AgreementView } from '@/types/api';
import { withOrg, type OrgContext } from '@/lib/data/tenant';

/**
 * The organisation's latest agreement record (FR-ORG-05, S-30; SRS line 333), on the tenant lane: row-level
 * security limits it to the context's organisation, and `makrai_app` holds SELECT on
 * `organization_agreements` (SRS 9.5 grant table, line 3674). Every member may read it. `null` when the
 * organisation has none (one created before agreements were recorded keeps working, FR-ORG-06).
 */
export async function currentAgreement(ctx: OrgContext): Promise<AgreementView | null> {
  const a = await withOrg(ctx, (tx) => tx.organisationAgreement.findFirst({
    orderBy: [{ recordedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, agreementVersion: true, textHash: true, acceptedOn: true, controllerLegalName: true, dpContactEmail: true, recordedAt: true },
  }));
  if (!a) return null;
  return {
    id: a.id, agreementVersion: a.agreementVersion, textHash: a.textHash,
    acceptedOn: a.acceptedOn.toISOString().slice(0, 10),   // a @db.Date column, read as UTC midnight
    controllerLegalName: a.controllerLegalName, dpContactEmail: a.dpContactEmail, recordedAt: a.recordedAt.toISOString(),
  };
}
