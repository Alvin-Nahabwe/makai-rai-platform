import { ConflictError } from '../http/errors';
import { NotFoundError, type TenantTx } from './tenant';

/**
 * FR-PRJ-03: an archived project is read-only. Every write service calls this first, inside its
 * own transaction. The read takes the project row FOR SHARE (gap G092; executed claim E-19 T10),
 * so `archiveProject`'s UPDATE of the row waits for writes already in flight, and a write that
 * starts after the archive commits sees `archivedAt`. RLS scopes the read to the transaction's
 * organisation, so another organisation's project is "not found".
 */
export async function assertProjectWritable(tx: TenantTx, projectId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ archivedAt: Date | null }[]>`
    SELECT "archivedAt" FROM "projects" WHERE "id" = ${projectId} FOR SHARE`;
  if (rows.length === 0) throw new NotFoundError();
  if (rows[0].archivedAt !== null) throw new ConflictError('project_archived');
}
