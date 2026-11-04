import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { testDb, resetDb } from '../helpers/db';
import { FIXTURE_QUESTION_IDS, useFixtureContent } from '../helpers/content';
import { markerText } from '../helpers/markers';
import { captureLogs, scanLines } from '../helpers/logCapture';
import {
  addDecision, addEvidence, addIssuedDocument, addProject, addSealRow, addStageReview, buildOrg, ctxFor, type OrgFixture,
} from '../helpers/recordFixture';
import type { OrgContext } from '../../lib/data/tenant';
import type { Actor } from '../../types/record';
import * as zip from '../../lib/export/zip';
import { MAX_RUNNING_EXPORTS, releaseTeamExport, writeTeamExport, type TeamExportJson } from '../../lib/data/export';
import { README_TEXT } from '../../lib/export/readme';

/**
 * writeTeamExport (00-contract.md, Services, lib/data/export.ts; SRS 6.3, ADR-C7): one ZIP from one
 * snapshot, written to a temporary file only its owner can read, at most two running in the process,
 * and the file gone once it is released, fails or is left for six hours. Every free text of the
 * fixture carries a marker (H0), so the log scan can find any record text that reaches a log line.
 */

let fx: OrgFixture;
let ctx: OrgContext;
let admin: Actor;
let owner: Actor;
let projectId: string;
let erasedId: string;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const exportDirs = () => readdirSync(tmpdir()).filter((d) => d.startsWith('makrai-export-'));

beforeAll(async () => {
  await resetDb();
  for (const d of exportDirs()) rmSync(join(tmpdir(), d), { recursive: true, force: true });
  const content = await useFixtureContent('0.0.1-fixture');
  const q = { stage: 'pre-processing' as const, questionId: FIXTURE_QUESTION_IDS[0], contentVersionId: content.contentVersionId };
  fx = await buildOrg({ label: 'expz', text: markerText });
  ctx = ctxFor(fx, 'admin');
  admin = { userId: fx.members.admin.userId, role: 'admin' };
  owner = { userId: fx.members.owner.userId, role: 'owner' };
  projectId = (await addProject(fx)).id;
  const other = (await addProject(fx)).id;
  const a = await addEvidence(fx, projectId, { kind: 'file', fileName: 'consent form.pdf', bytes: Buffer.from('%PDF-1.4 consent') });
  const b = await addEvidence(fx, other, { kind: 'file', fileName: 'data sheet.pdf', bytes: Buffer.from('%PDF-1.4 sheet') });
  const link = await addEvidence(fx, projectId, { kind: 'link', url: 'https://example.org/policy' });
  const erased = await addEvidence(fx, projectId, { kind: 'file', fileName: 'erased.pdf', bytes: Buffer.from('%PDF-1.4 erased') });
  erasedId = erased.id;
  await addDecision(fx, projectId, { ...q, status: 'done', evidenceIds: [a.id, link.id, erased.id] });
  await addDecision(fx, other, { ...q, status: 'done', evidenceIds: [b.id] });
  await testDb.$executeRaw`SELECT erase_evidence_bytes(${fx.org.id}, ${erased.id}, 'operator_test', 'REF-EXP-1')`;
  const review = await addStageReview(fx, projectId, { stage: q.stage });
  const seal = await addSealRow(fx, review.id, { contentVersionId: content.contentVersionId });
  await addIssuedDocument(fx, review.id, { documentType: 'data_card', sealIds: [seal.id], pdf: Buffer.from('%PDF-1.4 issued') });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('writeTeamExport', () => {
  it('FR-EXP-01: the ZIP holds export.json, README.txt, every evidence file not erased with its stored SHA-256, and every issued PDF', async () => {
    const r = await writeTeamExport(ctx, admin, { projectId: null });
    const files = unzipSync(new Uint8Array(readFileSync(r.path)));
    expect(Object.keys(files).slice(0, 2)).toEqual(['export.json', 'README.txt']);
    const json = JSON.parse(strFromU8(files['export.json'])) as TeamExportJson;
    const evidence = [...json.projects.flatMap((p) => p.evidence), ...json.unattachedEvidence];
    const withFiles = evidence.filter((e) => e.file);
    expect(withFiles).toHaveLength(2);
    for (const e of withFiles) expect(sha256(files[e.file!])).toBe(e.sha256);
    expect(evidence.find((e) => e.id === erasedId)!.file).toBeNull();
    expect(Object.keys(files).filter((n) => n.includes(erasedId))).toEqual([]);
    const docs = json.projects.flatMap((p) => p.issuedDocuments).filter((d) => d.file);
    expect(docs).toHaveLength(1);
    for (const d of docs) expect(sha256(files[d.file!])).toBe(d.sha256);
    expect(Object.keys(files)).toHaveLength(2 + withFiles.length + docs.length);
    expect(strFromU8(files['README.txt'])).toBe(README_TEXT);
    expect(r.fileName).toMatch(/^makrai-export-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(r.fileName).toBe(`makrai-export-${fx.org.slug}-${new Date().toISOString().slice(0, 10)}.zip`);
    expect(r.bytes).toBe(statSync(r.path).size);
    await releaseTeamExport(r.path);
  });

  it('FR-EXP-01: a project export holds that project only and names it in the file name', async () => {
    const r = await writeTeamExport(ctx, admin, { projectId });
    const files = unzipSync(new Uint8Array(readFileSync(r.path)));
    const json = JSON.parse(strFromU8(files['export.json'])) as TeamExportJson;
    expect(json.projects.map((p) => p.id)).toEqual([projectId]);
    expect(json.scope).toEqual({ projectId });
    expect(r.fileName).toBe(`makrai-export-${fx.org.slug}-${projectId.slice(0, 8)}-${new Date().toISOString().slice(0, 10)}.zip`);
    await releaseTeamExport(r.path);
  });

  it('FR-EXP-01 (SRS 6.3): the README names the format id, how to check a seal and why links are not included', () => {
    expect(README_TEXT).toContain('makrai.team-export/1');
    expect(README_TEXT).toMatch(/SHA-256 of the manifest/);
    expect(README_TEXT).toMatch(/link/i);
    expect(README_TEXT).toContain('export.json');
    expect(README_TEXT).toContain('evidence/');
    expect(README_TEXT).toContain('documents/');
    expect(README_TEXT).not.toMatch(/[<>]/);
  });

  it('FR-EXP-01 ADR-C7: the temporary file is 0600 and gone after release, after a failed write, and after 6 hours', async () => {
    const r = await writeTeamExport(ctx, admin, { projectId });
    expect(statSync(r.path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(r.path)).mode & 0o777).toBe(0o700);
    expect(dirname(dirname(r.path))).toBe(tmpdir());
    await releaseTeamExport(r.path);
    expect(existsSync(dirname(r.path))).toBe(false);
    await releaseTeamExport(r.path); // idempotent

    vi.spyOn(zip, 'openZipFile').mockImplementationOnce(() => { throw new Error('disk full'); });
    await expect(writeTeamExport(ctx, admin, { projectId })).rejects.toThrow('disk full');
    expect(exportDirs()).toEqual([]);

    const timers = vi.spyOn(globalThis, 'setTimeout');
    const late = await writeTeamExport(ctx, admin, { projectId });
    const expiry = timers.mock.calls.find((c) => c[1] === 6 * 60 * 60 * 1000);
    expect(expiry).toBeDefined();
    (expiry![0] as () => void)();
    await vi.waitFor(() => expect(existsSync(dirname(late.path))).toBe(false));
    // the expired export's slot is free again: two more can start
    const x = await writeTeamExport(ctx, admin, { projectId }); const y = await writeTeamExport(ctx, admin, { projectId });
    await releaseTeamExport(x.path); await releaseTeamExport(y.path);
  });

  it('FR-EXP-01 ADR-C7: an export directory older than 24 hours is removed at the next export, a recent one is not', async () => {
    const old = join(tmpdir(), 'makrai-export-stale1'); const recent = join(tmpdir(), 'makrai-export-recent1');
    mkdirSync(old); mkdirSync(recent);
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(old, dayAgo, dayAgo);
    const r = await writeTeamExport(ctx, admin, { projectId });
    expect([existsSync(old), existsSync(recent)]).toEqual([false, true]);
    rmSync(recent, { recursive: true });
    await releaseTeamExport(r.path);
  });

  it('FR-EXP-01 NFR-SEC-20: two exports hold the two slots and a third gets export_busy until one is released', async () => {
    expect(MAX_RUNNING_EXPORTS).toBe(2);
    const a = await writeTeamExport(ctx, admin, { projectId });
    const b = await writeTeamExport(ctx, admin, { projectId });
    await expect(writeTeamExport(ctx, owner, { projectId })).rejects.toMatchObject({ status: 429, code: 'export_busy', extra: { retryAfterSeconds: 60 } });
    expect(exportDirs()).toHaveLength(2); // the refused export made no directory
    await releaseTeamExport(a.path);
    const c = await writeTeamExport(ctx, owner, { projectId });
    await releaseTeamExport(b.path); await releaseTeamExport(c.path);
  });

  it('FR-EXP-01 NFR-SEC-02: a project of another organisation answers 404, writes no file and holds no slot', async () => {
    const otherOrg = await buildOrg({ label: 'expy' });
    const foreign = (await addProject(otherOrg)).id;
    await expect(writeTeamExport(ctx, admin, { projectId: foreign })).rejects.toMatchObject({ status: 404 });
    expect(exportDirs()).toEqual([]);
    const a = await writeTeamExport(ctx, admin, { projectId }); const b = await writeTeamExport(ctx, admin, { projectId });
    await releaseTeamExport(a.path); await releaseTeamExport(b.path);
  });

  it('NFR-OBS-01 NFR-PRIV-03: one EXPORT_MADE line with ids only', async () => {
    const { result, lines } = await captureLogs(() => writeTeamExport(ctx, admin, { projectId }));
    const made = lines.filter((l) => l.includes('EXPORT_MADE'));
    expect(made).toHaveLength(1);
    expect(JSON.parse(made[0])).toMatchObject({ event: 'EXPORT_MADE', userId: admin.userId, details: { orgId: fx.org.id, projectId, bytes: result.bytes } });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    expect(made[0]).not.toContain(fx.org.name);
    await releaseTeamExport(result.path);
  });
});
