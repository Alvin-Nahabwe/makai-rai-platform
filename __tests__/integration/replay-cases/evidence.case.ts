// FR-DEC-07 NFR-INT-02 replay case for app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts
import { randomUUID } from 'node:crypto';
import type { ReplayCase } from '../../helpers/replayCases';
import { testDb } from '../../helpers/db';
import { addProject } from '../../helpers/recordFixture';

const PDF = Buffer.from('%PDF-1.4\nreplay case pdf\n%%EOF');
const OTHER_PDF = Buffer.from('%PDF-1.4\nreplay case pdf, changed\n%%EOF');

function form(requestId: string, bytes: Buffer): FormData {
  const f = new FormData();
  f.set('requestId', requestId);
  f.set('file', new File([new Uint8Array(bytes)], 'replay.pdf', { type: 'application/pdf' }));
  return f;
}

/** Contract route row 3: a file uploaded to a new project by its assessor; rows() counts the organisation's evidence rows. */
export const replayCase: ReplayCase = {
  route: 'app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts',
  method: 'POST',
  async prepare(fx) {
    const project = await addProject(fx);
    const requestId = randomUUID();
    return {
      role: 'assessor',
      params: { slug: fx.org.slug, id: project.id },
      body: () => form(requestId, PDF),
      changedBody: () => form(requestId, OTHER_PDF),
      rows: () => testDb.evidence.count({ where: { orgId: fx.org.id } }),
      resourceId: (json) => (json as { id: string }).id,
    };
  },
};
