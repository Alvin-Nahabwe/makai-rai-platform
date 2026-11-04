/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { TenantTx } from '@/lib/data/tenant';
import type { Stage } from '@/types/record';
import type { SealedIdSet } from '../integrity/sealCheck.mjs';
import { NotImplementedError } from '@/lib/http/errors';

/**
 * The id sets of FR-REV-05. `manifestIds` and `SealedIdSet` are the pure seal check's own
 * (`lib/integrity/sealCheck.mjs`), re-exported so importers use this contract path and get the
 * same function, not a copy.
 */
export { manifestIds } from '../integrity/sealCheck.mjs';
export type { SealedIdSet } from '../integrity/sealCheck.mjs';

// CONTRACT_STUB: REV-a
export async function stageSnapshotIds(tx: TenantTx, projectId: string, stage: Stage): Promise<SealedIdSet> {
  throw new NotImplementedError('REV-a');
}
