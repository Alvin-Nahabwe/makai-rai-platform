import type { TenantTx } from '@/lib/data/tenant';
import type { Stage } from '@/types/record';
import type { SealedIdSet } from '../integrity/sealCheck.mjs';
import { loadContent } from '@/lib/content/loader';
import { resolveRunningContentVersion } from '@/lib/data/framework';
import { readStageRows, stagePlan } from './manifest';

/**
 * The id sets of FR-REV-05. `manifestIds` and `SealedIdSet` are the pure seal check's own
 * (`lib/integrity/sealCheck.mjs`), re-exported so importers use this contract path and get the
 * same function, not a copy.
 */
export { manifestIds } from '../integrity/sealCheck.mjs';
export type { SealedIdSet } from '../integrity/sealCheck.mjs';

/**
 * The ids a seal of the stage taken now would name (REV-b compares them with `manifestIds` of the last seal for
 * "changed since seal"). Run it inside `withOrg`; at `RepeatableRead` its reads share one snapshot.
 */
export async function stageSnapshotIds(tx: TenantTx, projectId: string, stage: Stage): Promise<SealedIdSet> {
  const content = loadContent((await resolveRunningContentVersion(tx)).semver);
  return stagePlan(await readStageRows(tx, projectId, stage), { stage, content }).ids;
}
