/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { TenantTx } from '@/lib/data/tenant';
import type { Stage } from '@/types/record';
import type { SealManifestV1 } from '@/types/seal';
import { NotImplementedError } from '@/lib/http/errors';

/** The id sets of FR-REV-05. Typed stubs until the producer merges. */

export type SealedIdSet = {
  decisionVersions: string[]; evidence: string[]; findings: string[]; findingEvents: string[];
  mitigationVersions: string[]; acceptedRisks: string[];
};

// CONTRACT_STUB: REV-a
export async function stageSnapshotIds(tx: TenantTx, projectId: string, stage: Stage): Promise<SealedIdSet> {
  throw new NotImplementedError('REV-a');
}

// CONTRACT_STUB: REV-a
export function manifestIds(m: SealManifestV1): SealedIdSet {
  throw new NotImplementedError('REV-a');
}
