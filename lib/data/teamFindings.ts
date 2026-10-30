/* eslint-disable @typescript-eslint/no-unused-vars -- stub bodies keep the contract's parameter names; the producer replaces the file's bodies. */
import type { OrgContext } from '@/lib/data/tenant';
import type { Actor, WriteOutcome } from '@/types/record';
import type { FindingView, RaiseTeamFindingRequest } from '@/types/api';
import { NotImplementedError } from '@/lib/http/errors';

/** Raise a team finding (FR-FND-02). Typed stub until the producer merges. */

// CONTRACT_STUB: FND-b
export async function raiseTeamFinding(
  ctx: OrgContext, actor: Actor, a: RaiseTeamFindingRequest & { projectId: string }, digest: string,
): Promise<WriteOutcome<FindingView>> {
  throw new NotImplementedError('FND-b');
}
