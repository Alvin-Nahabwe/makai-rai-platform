import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import { GET, DELETE, buildContentDisposition } from '@/app/api/v1/orgs/[slug]/evidence/[evidenceId]/route';
import { resetDb, testDb } from '../helpers/db';
import { clearSession, sessionFor } from '../helpers/authSession';
import { captureLogs } from '../helpers/logCapture';
import { addEvidence, addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';

/**
 * The download route (contract route row 4). Rows are written through testDb (the schema owner), which is also
 * the only way to make a row the app would never write: a stored hash that is not the bytes' hash, or no blob at
 * all. The DELETE method answers 404 since v0.6.0 (FR-AUTHZ-02).
 */

// NFR-AVL-04 case: the next call of withOrg rejects once, as an unreachable database does.
const outage = vi.hoisted(() => ({ armed: false }));
vi.mock('@/lib/data/tenant', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/tenant')>();
  return {
    ...real,
    withOrg: ((...args: Parameters<typeof real.withOrg>) => {
      if (outage.armed) {
        outage.armed = false;
        return Promise.reject(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }));
      }
      return real.withOrg(...args);
    }) as typeof real.withOrg,
  };
});

const PDF_BYTES = Buffer.from('%PDF-1.4\ndownload fixture\n%%EOF');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let fx: OrgFixture;
let fxB: OrgFixture;
let p: { id: string };

beforeEach(async () => {
  await resetDb();
  outage.armed = false;
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'b' });
  p = await addProject(fx);
  clearSession();
});

function download(role: OrgRole | null, evidenceId: string): Promise<Response> {
  if (role) sessionFor(fx.members[role].userId); else clearSession();
  return GET(new NextRequest('http://localhost/probe', { method: 'GET' }), { params: Promise.resolve({ slug: fx.org.slug, evidenceId }) });
}
function callDelete(role: OrgRole, evidenceId: string): Promise<Response> {
  sessionFor(fx.members[role].userId);
  return DELETE(new NextRequest('http://localhost/probe', { method: 'DELETE' }), { params: Promise.resolve({ slug: fx.org.slug, evidenceId }) });
}

/** A file row whose stored hash is that of other bytes than its blob holds. */
async function insertEvidenceWithWrongHash(bytes: Buffer): Promise<string> {
  const row = await testDb.evidence.create({ data: {
    orgId: fx.org.id, projectId: p.id, kind: 'file', filename: 'bad.pdf', mimeType: 'application/pdf', byteSize: bytes.byteLength,
    sha256: sha(Buffer.from('other bytes')), uploadedById: fx.members.assessor.userId, requestId: randomUUID(), requestDigest: 'd',
  } });
  await testDb.evidenceBlob.create({ data: { evidenceId: row.id, orgId: fx.org.id, content: new Uint8Array(bytes) } });
  return row.id;
}
async function insertEvidenceWithoutBlob(): Promise<string> {
  const bytes = Buffer.from('gone');
  return (await testDb.evidence.create({ data: {
    orgId: fx.org.id, projectId: p.id, kind: 'file', filename: 'gone.pdf', mimeType: 'application/pdf', byteSize: bytes.byteLength,
    sha256: sha(bytes), uploadedById: fx.members.assessor.userId, requestId: randomUUID(), requestDigest: 'd',
  } })).id;
}
const todayUtc = () => new Date().toISOString().slice(0, 10);

describe('evidence download route', () => {
  it('NFR-SEC-10 FR-EVD-02: download is an octet-stream attachment and CRLF in a name cannot inject a header', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', fileName: 'a\r\nSet-Cookie: x=1.pdf', bytes: PDF_BYTES });
    const res = await download('assessor', ev.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-disposition')).toMatch(/^attachment; /);
    expect(res.headers.get('content-disposition')).not.toMatch(/[\r\n]/);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-content-type-options')).toBeNull();   // nginx's alone (docker/nginx/default.conf)
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
  });

  it('NFR-SEC-10: a quote and a backslash in a name are encoded per RFC 6266', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', fileName: 'evil\\.txt", x="pwned', bytes: PDF_BYTES });
    const cd = (await download('assessor', ev.id)).headers.get('content-disposition');
    expect(cd).toBe(`attachment; filename="evil_.txt_, x=_pwned"; filename*=UTF-8''evil%5C.txt%22%2C%20x%3D%22pwned`);
  });

  it('NFR-SEC-10: the stored mimeType never reaches Content-Type, and Content-Length is the served bytes, not the stored byteSize', async () => {
    const bytes = Buffer.from('%PDF-1.4\nwrong size\n');
    const row = await testDb.evidence.create({ data: {
      orgId: fx.org.id, projectId: p.id, kind: 'file', filename: 'w.pdf', mimeType: 'text/html', byteSize: 3,
      sha256: sha(bytes), uploadedById: fx.members.assessor.userId, requestId: randomUUID(), requestDigest: 'd',
    } });
    await testDb.evidenceBlob.create({ data: { evidenceId: row.id, orgId: fx.org.id, content: new Uint8Array(bytes) } });
    const res = await download('assessor', row.id);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength));
  });

  it('NFR-INT-06: a hash mismatch answers 500 integrity_failure, logs once with the downloader and serves no byte', async () => {
    const id = await insertEvidenceWithWrongHash(PDF_BYTES);   // uploaded by the assessor
    const { result, lines } = await captureLogs(() => download('owner', id));   // downloaded by the owner
    expect(result.status).toBe(500);
    const body = await result.json();
    expect(body).toMatchObject({ code: 'integrity_failure' });
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{64}/);
    const logged = lines.filter((l) => l.includes('EVIDENCE_INTEGRITY_FAILURE'));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain(fx.members.owner.userId);          // who was downloading when the corruption was found
    expect(logged[0]).not.toContain(fx.members.assessor.userId);   // not the uploader
    expect(logged[0]).toContain(fx.org.id);
  });

  it('NFR-INT-06: an evidence row without a blob and without a tombstone answers 500 integrity_failure', async () => {
    const { result, lines } = await captureLogs(async () => download('assessor', await insertEvidenceWithoutBlob()));
    expect(await result.json()).toMatchObject({ code: 'integrity_failure' });
    expect(lines.filter((l) => l.includes('EVIDENCE_INTEGRITY_FAILURE') && l.includes('missing_blob'))).toHaveLength(1);
  });

  it('FR-EVD-05: after the operator erases the bytes, the row and hash stay and the download answers 410 with the date', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', bytes: PDF_BYTES });
    await testDb.$executeRaw`SELECT erase_evidence_bytes(${fx.org.id}, ${ev.id}, 'ER-1', 'INSTR-1')`;
    expect(await testDb.evidenceBlob.count({ where: { evidenceId: ev.id } })).toBe(0);
    expect((await testDb.evidence.findUnique({ where: { id: ev.id } }))!.sha256).toBe(ev.sha256);
    const res = await download('assessor', ev.id);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: 'erased', erasedOn: todayUtc() });
  });

  it("NFR-SEC-02: downloading organisation B's evidence and a missing id answer the same coded 404", async () => {
    const projectB = await addProject(fxB);
    const evidenceOfB = await addEvidence(fxB, projectB.id, { kind: 'file', bytes: PDF_BYTES });
    const foreign = await download('owner', evidenceOfB.id);
    const missing = await download('owner', randomUUID());
    expect([foreign.status, missing.status]).toEqual([404, 404]);
    const [a, b] = [await foreign.json(), await missing.json()];
    expect(a).toMatchObject({ code: 'not_found' });
    expect(b).toEqual(a);
  });

  it("FR-EVD-06: an unattached file stays readable by id to every member of the organisation, as the Why of FR-EVD-06 says", async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', bytes: PDF_BYTES }, 'assessor');
    for (const role of ['assessor', 'owner', 'admin', 'reviewer', 'viewer'] as const) {
      const res = await download(role, ev.id);
      expect([role, res.status]).toEqual([role, 200]);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
    }
  });

  it('FR-EVD-01: a link item has nothing to download and answers 404', async () => {
    expect((await download('assessor', (await addEvidence(fx, p.id, { kind: 'link', url: 'https://e.org/x' })).id)).status).toBe(404);
  });

  it('FR-EVD-02 NFR-SEC-11: a name an operator erased downloads as evidence-<id>', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', bytes: PDF_BYTES });
    await testDb.$executeRaw`SELECT erase_text_field(${fx.org.id}, 'evidence', ${ev.id}, 'fileName', 'ER-2', 'INSTR-2')`;
    const res = await download('assessor', ev.id);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(`evidence-${ev.id}`);
  });

  it('NFR-SEC-10: buildContentDisposition does not throw on a name with a lone UTF-16 surrogate', () => {
    const result = buildContentDisposition('evil\uD800filename.pdf');
    expect(result).toMatch(/^attachment; filename="[^]*"; filename\*=UTF-8''.*$/);
  });

  it('FR-AUTHZ-01: an unauthenticated download answers 401', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', bytes: PDF_BYTES });
    expect((await download(null, ev.id)).status).toBe(401);
  });

  it('NFR-AVL-04 NFR-OBS-05: with the database unreachable, the download answers 503 database_unavailable with a reference and writes one REQUEST_FAILED line', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', bytes: PDF_BYTES });
    const { result, lines } = await captureLogs(() => { outage.armed = true; return download('assessor', ev.id); });
    const body = await result.json();
    expect([result.status, body]).toEqual([503, { error: 'Service unavailable', code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
    expect(lines.filter((l) => l.includes('REQUEST_FAILED') && l.includes(body.reference))).toHaveLength(1);
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|127\.0\.0\.1/);
  });

  it('FR-AUTHZ-02: DELETE .../evidence/<id> answers 404 and leaves the row and its blob, whatever the evidence is', async () => {
    const ev = await addEvidence(fx, p.id, { kind: 'file', bytes: PDF_BYTES });
    for (const id of [ev.id, randomUUID()]) {
      const res = await callDelete('owner', id);
      expect([id, res.status, await res.json()]).toEqual([id, 404, { error: 'Not found', code: 'not_found' }]);
    }
    expect(await testDb.evidence.count({ where: { id: ev.id } })).toBe(1);
    expect(await testDb.evidenceBlob.count({ where: { evidenceId: ev.id } })).toBe(1);
  });
});
