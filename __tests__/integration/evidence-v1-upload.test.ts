import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import { POST } from '@/app/api/v1/orgs/[slug]/projects/[id]/evidence/route';
import { GET } from '@/app/api/v1/orgs/[slug]/evidence/[evidenceId]/route';
import { MAX_BYTES } from '@/lib/evidence/inspect';
import { stripBidiControls } from '@/lib/evidence/format';
import { resetDb, testDb } from '../helpers/db';
import { clearSession, sessionFor } from '../helpers/authSession';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { HOSTILE_FILE_NAMES } from '../helpers/hostile';
import { addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';

const PDF_BYTES = Buffer.from('%PDF-1.4\nfixture pdf one\n%%EOF');
const OTHER_PDF = Buffer.from('%PDF-1.4\nfixture pdf two\n%%EOF');
const R1 = '0b3f6c1e-5a2d-4f7b-9d41-6a1f2c3d4e51';
const R2 = '7c9e2a14-3b8d-4e60-8f12-5d6a7b8c9d02';
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let fx: OrgFixture;
let fxB: OrgFixture;
let project: { id: string };
let projectOfB: { id: string };

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'b' });
  project = await addProject(fx);
  projectOfB = await addProject(fxB);
  clearSession();
});

function fileForm(name: string, bytes: Buffer, o: { declared?: string; requestId?: string } = {}): FormData {
  const f = new FormData();
  f.set('requestId', o.requestId ?? randomUUID());
  f.set('file', new File([new Uint8Array(bytes)], name, { type: o.declared ?? 'application/octet-stream' }));
  return f;
}
const linkBody = (url: string, label: string | null = null, requestId: string = randomUUID()) => ({ requestId, kind: 'link', url, label });

type PostOpts = { projectId?: string; contentLength?: string; origin?: string };
function post(role: OrgRole, body: FormData | Record<string, unknown> | null, opts: PostOpts = {}): Promise<Response> {
  sessionFor(fx.members[role].userId);
  const id = opts.projectId ?? project.id;
  const url = `http://localhost/api/v1/orgs/${fx.org.slug}/projects/${id}/evidence`;
  const headers: Record<string, string> = {};
  if (opts.contentLength !== undefined) headers['content-length'] = opts.contentLength;
  if (opts.origin !== undefined) {
    headers.origin = opts.origin === 'own' ? new URL(url).origin : opts.origin;
    headers.host = new URL(url).host;
  }
  let init: NonNullable<ConstructorParameters<typeof NextRequest>[1]>;
  if (body === null) init = { method: 'POST', headers: { ...headers, 'content-type': 'multipart/form-data; boundary=x' } };
  else if (body instanceof FormData) init = { method: 'POST', body, headers };
  else init = { method: 'POST', body: JSON.stringify(body), headers: { ...headers, 'content-type': 'application/json' } };
  return POST(new NextRequest(url, init), { params: Promise.resolve({ slug: fx.org.slug, id }) });
}
function download(role: OrgRole, evidenceId: string): Promise<Response> {
  sessionFor(fx.members[role].userId);
  return GET(new NextRequest('http://localhost/probe'), { params: Promise.resolve({ slug: fx.org.slug, evidenceId }) });
}
const evidenceCount = () => testDb.evidence.count();
const blobBytes = async (id: string) => Buffer.from((await testDb.evidenceBlob.findUniqueOrThrow({ where: { evidenceId: id } })).content);
const storedFilename = async (id: string) => (await testDb.evidence.findUniqueOrThrow({ where: { id } })).filename;

describe('route 3: add evidence to a project', () => {
  it('FR-EVD-01 FR-EVD-02: an assessor uploads a PDF; the row holds the bytes hash, type from bytes and the uploader', async () => {
    const res = await post('assessor', fileForm('consent.pdf', PDF_BYTES, { declared: 'image/png' }));
    expect(res.status).toBe(201);
    const v = await res.json();
    expect(v).toMatchObject({ kind: 'file', fileName: 'consent.pdf', mimeType: 'application/pdf', byteSize: PDF_BYTES.length, sha256: sha(PDF_BYTES), uploadedBy: { userId: fx.members.assessor.userId }, erased: null });
    expect(await blobBytes(v.id)).toEqual(PDF_BYTES);
  });

  it('FR-EVD-02 NFR-SEC-10: the declared type is discarded and unrecognised bytes answer 400 unsupported_file_type', async () => {
    const res = await post('assessor', fileForm('x.png', Buffer.from('<html><script>alert(1)</script>'), { declared: 'image/png' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'unsupported_file_type' });
    expect(await evidenceCount()).toBe(0);
  });

  it('FR-EVD-02: a declared, non-numeric or negative Content-Length over the limit answers 413 file_too_large', async () => {
    for (const cl of [String(MAX_BYTES + 1), 'abc', '-1']) {
      const res = await post('assessor', null, { contentLength: cl });
      expect(res.status).toBe(413);
      expect(await res.json()).toMatchObject({ code: 'file_too_large' });
    }
  });

  it('FR-EVD-02: bytes over the limit that were not declared answer 413 file_too_large and write nothing', async () => {
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(MAX_BYTES)]);
    const res = await post('assessor', fileForm('big.pdf', big));
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ code: 'file_too_large' });
    expect(await evidenceCount()).toBe(0);
  });

  it('FR-EVD-01: a missing file, an unparsable multipart body and another content type answer 422', async () => {
    const noFile = new FormData(); noFile.set('requestId', randomUUID());
    const a = await post('assessor', noFile);
    expect(a.status).toBe(422);
    expect(await a.json()).toMatchObject({ code: 'validation', fields: [{ field: 'file' }] });
    const b = await post('assessor', null);
    expect(b.status).toBe(422);
    const c = await POST(new NextRequest(`http://localhost/x`, { method: 'POST', body: 'hi', headers: { 'content-type': 'text/plain' } }),
      { params: Promise.resolve({ slug: fx.org.slug, id: project.id }) });
    expect(c.status).toBe(422);
    expect(await c.json()).toMatchObject({ fields: [{ field: 'kind' }] });
  });

  it('FR-EVD-01: a link https://example.org/ethics.pdf is stored as a link item; ftp://x answers 422', async () => {
    expect((await post('assessor', linkBody('ftp://x'))).status).toBe(422);
    const res = await post('assessor', linkBody('https://example.org/ethics.pdf', 'Ethics approval'));
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ kind: 'link', url: 'https://example.org/ethics.pdf', label: 'Ethics approval', sha256: null, fileName: null });
    expect(await testDb.evidenceBlob.count()).toBe(0);
  });

  it('FR-DEC-07 NFR-INT-02: replaying POST app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts with the same request id creates nothing', async () => {
    const a = await post('assessor', fileForm('a.pdf', PDF_BYTES, { requestId: R1 }));
    const b = await post('assessor', fileForm('a.pdf', PDF_BYTES, { requestId: R1 }));
    expect([a.status, b.status]).toEqual([201, 200]);
    expect((await b.json()).id).toBe((await a.json()).id);
    expect(await evidenceCount()).toBe(1);
    expect((await post('assessor', fileForm('a.pdf', OTHER_PDF, { requestId: R1 }))).status).toBe(409);
    const l1 = await post('assessor', linkBody('https://e.org/x', null, R2));
    const l2 = await post('assessor', linkBody('https://e.org/x', null, R2));
    expect([l1.status, l2.status]).toEqual([201, 200]);
    expect((await post('assessor', linkBody('https://e.org/y', null, R2))).status).toBe(409);
  });

  it("NFR-INT-02: another account replaying an upload's request id gets 409 and no evidence data", async () => {
    await post('assessor', fileForm('a.pdf', PDF_BYTES, { requestId: R1 }));
    const res = await post('admin', fileForm('a.pdf', PDF_BYTES, { requestId: R1 }));
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('a.pdf');
  });

  it('FR-EVD-02 NFR-SEC-11: a hostile name round-trips through upload and download', async () => {
    for (const name of HOSTILE_FILE_NAMES) {
      const v = await (await post('assessor', fileForm(name, PDF_BYTES))).json();
      expect(v.fileName).toBe(name);
      expect(await storedFilename(v.id)).toBe(name);
      const cd = (await download('viewer', v.id)).headers.get('content-disposition')!;
      expect(decodeURIComponent(cd.split("filename*=UTF-8''")[1])).toBe(stripBidiControls(name));
      expect(cd).not.toMatch(/[\r\n‪-‮⁦-⁩]/);
      expect(cd.match(/filename="([^"]*)"/)![1]).not.toMatch(/[‪-‮⁦-⁩]/);
    }
  });

  it('NFR-SEC-11 FR-EVD-02 (E-name): route 3 stores a normalised name: controls removed, an empty name becomes "file"', async () => {
    const a = await (await post('assessor', fileForm('a\u0000b.pdf', PDF_BYTES))).json();
    expect(a.fileName).toBe('ab.pdf');
    expect(await storedFilename(a.id)).toBe('ab.pdf');
    const b = await (await post('assessor', fileForm('\u0001 ', OTHER_PDF))).json();
    expect(b.fileName).toBe('file');
  });

  it('FR-DEC-07 NFR-INT-02: the same upload request id sent to another project answers 409 and writes nothing there', async () => {
    expect((await post('assessor', fileForm('a.pdf', PDF_BYTES, { requestId: R1 }))).status).toBe(201);
    const other = await addProject(fx, { name: 'Other' });
    expect((await post('assessor', fileForm('a.pdf', PDF_BYTES, { requestId: R1 }), { projectId: other.id })).status).toBe(409);
    expect(await testDb.evidence.count({ where: { projectId: other.id } })).toBe(0);
  });

  it('FR-PRJ-03 RF-4: an upload or a link in an archived project answers 409 project_archived and writes nothing', async () => {
    const archived = await addProject(fx, { archived: true });
    for (const body of [fileForm('a.pdf', PDF_BYTES), linkBody('https://e.org/x')])
      expect(await (await post('assessor', body, { projectId: archived.id })).json()).toMatchObject({ code: 'project_archived' });
    expect(await evidenceCount()).toBe(0);
  });

  it('NFR-SEC-02 FR-EVD-01: reviewer and viewer get 403, a foreign Origin 403, nothing written', async () => {
    for (const role of ['reviewer', 'viewer'] as const) expect((await post(role, fileForm('a.pdf', PDF_BYTES))).status).toBe(403);
    expect((await post('assessor', fileForm('a.pdf', PDF_BYTES), { origin: 'https://evil.example' })).status).toBe(403);
    expect(await evidenceCount()).toBe(0);
    expect((await post('assessor', fileForm('a.pdf', PDF_BYTES), { origin: 'own' })).status).toBe(201);
  });

  it('FR-AUTHZ-01 NFR-MNT-01 (R12-18): route 3 is gated by evidence:create alone and never by decision:write, so the upload permission is independent of the answer permission', () => {
    const src = readFileSync('app/api/v1/orgs/[slug]/projects/[id]/evidence/route.ts', 'utf8');
    expect(src).toMatch(/requireOrgContextWithIdentity\(slug, 'evidence:create'\)/);
    expect(src).not.toMatch(/decision:write|decision:withdraw/);
  });

  it('NFR-SEC-02: an upload to a project of organisation B answers 404 and writes nothing', async () => {
    expect((await post('assessor', fileForm('a.pdf', PDF_BYTES), { projectId: projectOfB.id })).status).toBe(404);
    expect(await evidenceCount()).toBe(0);
  });

  it('NFR-OBS-01 NFR-PRIV-03: an upload logs EVIDENCE_UPLOADED once with ids and no file name', async () => {
    const { lines } = await captureLogs(() => post('assessor', fileForm(`${markerFor('fileName', 1)}.pdf`, PDF_BYTES)));
    expect(lines.filter((l) => l.includes('EVIDENCE_UPLOADED'))).toHaveLength(1);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-OBS-01: a replayed upload logs no second EVIDENCE_UPLOADED', async () => {
    await post('assessor', fileForm('a.pdf', PDF_BYTES, { requestId: R1 }));
    const { lines } = await captureLogs(() => post('assessor', fileForm('a.pdf', PDF_BYTES, { requestId: R1 })));
    expect(lines.filter((l) => l.includes('EVIDENCE_UPLOADED'))).toHaveLength(0);
  });
});
