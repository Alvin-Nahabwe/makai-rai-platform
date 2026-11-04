import { NextResponse } from 'next/server';
import { requireIdentityForApi } from '@/lib/auth/identity';
import { personalExport } from '@/lib/data/export';
import { toResponse } from '@/lib/http/toResponse';

/**
 * Route 38 (00-contract.md, Routes row 38; FR-EXP-02, SRS 6.4): the signed-in person's data as one JSON
 * file, `makrai.personal-export/1` (`personalExport`, lib/data/export.ts). It holds the account, current
 * memberships, every acceptance row, the sign-in rows, and the records the person entered or was named
 * in, by organisation, type, id and date, with none of the organisations' record text (that belongs to
 * each organisation; the team export carries it). Evidence bytes are not included.
 *
 * Gated with `allowMissingAcceptances: true` (G028): a person who has not accepted the current legal
 * texts can still take their data (FR-ACC-04, SRS line 491). The proxy limits it to 3 an hour.
 */
export async function GET() {
  try {
    const identity = await requireIdentityForApi({ allowMissingAcceptances: true });
    const body = await personalExport(identity.userId);
    return NextResponse.json(body, {
      headers: { 'Content-Disposition': `attachment; filename="makrai-export-${body.exportedAt.slice(0, 10)}.json"` },
    });
  } catch (e) {
    return toResponse(e);
  }
}
