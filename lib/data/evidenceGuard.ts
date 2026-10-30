import { ValidationFailed } from '../http/errors';
import type { TenantTx } from './tenant';

/**
 * FR-EVD-01, FR-EVD-04: evidence attached to a decision or mitigation version must be evidence
 * of the same project. Refuses, on the field `evidenceIds`, unless every id is an evidence row
 * of `projectId` in the transaction's organisation (RLS hides other organisations' rows, so
 * their ids fail the same way). An empty list attaches nothing and passes.
 */
export async function assertEvidenceAttachable(tx: TenantTx, projectId: string, evidenceIds: readonly string[]): Promise<void> {
  const wanted = [...new Set(evidenceIds)];
  if (wanted.length === 0) return;
  const found = await tx.evidence.count({ where: { projectId, id: { in: wanted } } });
  if (found !== wanted.length) {
    throw new ValidationFailed([{ field: 'evidenceIds', message: 'Every attached item must be evidence of this project.' }]);
  }
}
