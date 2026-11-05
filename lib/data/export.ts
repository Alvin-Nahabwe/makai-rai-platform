import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, open, readdir, rm, stat, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { OrgRole } from '@prisma/client';
import type { Actor, CalendarDate, UtcInstant } from '../../types/record';
import type { PersonalExport, PersonalExportItem, PersonalItemType } from '../../types/api';
import { compare, hash } from '../auth/passwordHash';
import { requireOrgContextFor } from '../auth/context';
import { AppError, RateLimitedError, ValidationFailed } from '../http/errors';
import { logSecurityEvent } from '../security-logger';
import { README_TEXT } from '../export/readme';
import { openZipFile, safeEvidenceEntryName, ZipLimitError } from '../export/zip';
import { unattachedEvidenceIn } from './evidence';
import { identityDb, scrubUserOnDeactivation } from './identity';
import { lastActiveOwnerOf } from './identityReads';
import { recordOrgEvent } from './orgEvents';
import { membershipsForUser } from './preauth';
import { withOrg, type OrgContext, type TenantTx } from './tenant';
import { userRefs } from './views';

/**
 * Team export, personal export and account deletion (FR-EXP-01 to 04; 00-contract.md, Services,
 * `lib/data/export.ts`).
 *
 * The team export's JSON (format `makrai.team-export/1`, SRS 6.3; schema
 * `docs/formats/team-export-1.json`) is read by `readExportSnapshot` inside the caller's one
 * transaction, which the caller opens at REPEATABLE READ so every query sees the same snapshot
 * (NFR-INT-10): a decision and the finding it raised are both in the file or neither is.
 */

export const TEAM_EXPORT_FORMAT = 'makrai.team-export/1';

export type ExportJson = string | number | boolean | null | ExportJson[] | { [key: string]: ExportJson };
/** One table row as stored, by column name, with the format's rules for times, dates and bytes. */
export type ExportRow = { [column: string]: ExportJson };

export type ExportEvidence = ExportRow & {
  id: string; kind: string; fileName: string | null; sha256: string | null;
  /** Its entry in the ZIP, or null for a link or a file whose bytes were erased. */
  file: string | null;
};
export type ExportIssuedDocument = ExportRow & {
  id: string; sha256: string;
  /** Its entry in the ZIP, or null when its PDF was erased. */
  file: string | null;
  withdrawn: { on: CalendarDate; reason: string } | null;
};
export type ExportProject = {
  id: string; name: string; description: string | null; createdAt: UtcInstant; archivedAt: UtcInstant | null;
  metadata: ExportRow | null;
  decisionVersions: Array<ExportRow & { id: string }>;
  decisionEvidence: Array<ExportRow & { versionId: string; evidenceId: string }>;
  evidence: ExportEvidence[];
  findings: Array<ExportRow & { id: string; decisionVersionId: string | null }>;
  findingEvents: ExportRow[];
  mitigationVersions: ExportRow[];
  mitigationEvidence: Array<ExportRow & { versionId: string; evidenceId: string }>;
  acceptedRisks: ExportRow[];
  stageReviews: ExportRow[];
  seals: Array<ExportRow & { id: string; fingerprint: string }>;
  issuedDocuments: ExportIssuedDocument[];
  issuedDocumentSeals: ExportRow[];
  documentEvents: ExportRow[];
};
export type TeamExportJson = {
  format: typeof TEAM_EXPORT_FORMAT;
  exportedAt: UtcInstant;
  organisation: { id: string; name: string };
  scope: { projectId: string | null };
  members: Array<{ userId: string; name: string; role: OrgRole }>;
  projects: ExportProject[];
  /** Evidence of the scope that no decision or mitigation version names, of every uploader (FR-EVD-06). */
  unattachedEvidence: ExportEvidence[];
  tombstones: ExportRow[];
};

export type SnapshotHooks = {
  /** Test seam (NFR-INT-10's race): runs after the decision versions are read, before anything else. */
  afterDecisions?: (tx: TenantTx) => Promise<void>;
};

/** `@db.Date` columns, written as YYYY-MM-DD; every other time is a UTC instant. */
const CALENDAR_DATE_COLUMNS = new Set(['decision_versions.declaredOn', 'mitigation_versions.dueDate', 'accepted_risks.lookAgainOn']);

/** One stored value in the format's form (SRS 6.3; the schema's description). */
function cell(table: string, column: string, value: unknown): ExportJson {
  if (value === null) return null;
  if (value instanceof Date) {
    const instant = value.toISOString();
    return CALENDAR_DATE_COLUMNS.has(`${table}.${column}`) ? instant.slice(0, 10) : instant;
  }
  if (value instanceof Uint8Array) {
    if (column.endsWith('Salt')) return Buffer.from(value).toString('hex');
    if (table === 'seals' && column === 'manifest') return Buffer.from(value).toString('base64');
    // A bytes column with no rule is a new column the format does not cover: refuse to guess.
    throw new TypeError(`team export: no rule for the bytes column ${table}.${column}`);
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value) || typeof value === 'object') return value as ExportJson; // String[] and Json columns
  throw new TypeError(`team export: no rule for ${table}.${column} (${typeof value})`);
}

function row(table: string, r: object): ExportRow {
  const out: ExportRow = {};
  for (const [column, value] of Object.entries(r)) out[column] = cell(table, column, value);
  return out;
}

/** Groups rows by the project they belong to, keeping their order. */
function byProject<T>(rows: readonly T[], projectOf: (r: T) => string | undefined): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const p = projectOf(r);
    if (p === undefined) throw new TypeError('team export: a row of the snapshot has no project in it');
    out.set(p, [...(out.get(p) ?? []), r]);
  }
  return out;
}

/**
 * The team export's JSON for the whole organisation (`projectId` null) or one project, read
 * through `tx` only, one query per table, ordered by id. The caller opens `tx` with
 * `withOrg(ctx, cb, { isolationLevel: 'RepeatableRead' })`; row-level security limits every read
 * to the organisation, so a project id of another organisation is absent and answers 404.
 */
export async function readExportSnapshot(tx: TenantTx, scope: { projectId: string | null }, hooks: SnapshotHooks = {}): Promise<TeamExportJson> {
  const projects = await tx.project.findMany({
    where: scope.projectId === null ? {} : { id: scope.projectId },
    select: { id: true, name: true, description: true, createdAt: true, archivedAt: true },
    orderBy: { id: 'asc' },
  });
  if (scope.projectId !== null && projects.length === 0) throw new AppError(404, 'not_found', 'Not found');
  const projectIds = projects.map((p) => p.id);
  const inScope = { projectId: { in: projectIds } };

  const decisionVersions = await tx.decisionVersion.findMany({ where: inScope, orderBy: { id: 'asc' } });
  await hooks.afterDecisions?.(tx);

  const organisation = await tx.organization.findFirstOrThrow({ select: { id: true, name: true } });
  const memberships = await tx.membership.findMany({ select: { userId: true, role: true }, orderBy: { id: 'asc' } });
  const metadata = await tx.projectMetadata.findMany({ where: inScope, orderBy: { id: 'asc' } });
  const decisionEvidence = await tx.decisionEvidence.findMany({
    where: { version: inScope }, orderBy: [{ versionId: 'asc' }, { evidenceId: 'asc' }],
  });
  const unattachedIds = new Set((await unattachedEvidenceIn(tx, scope.projectId, null)).map((v) => v.id));
  const evidence = await tx.evidence.findMany({
    where: { OR: [inScope, { id: { in: [...unattachedIds] } }] }, orderBy: { id: 'asc' },
  });
  const withBytes = new Set((await tx.evidenceBlob.findMany({
    where: { evidenceId: { in: evidence.map((e) => e.id) } }, select: { evidenceId: true },
  })).map((b) => b.evidenceId));
  const findings = await tx.finding.findMany({ where: inScope, orderBy: { id: 'asc' } });
  const findingEvents = await tx.findingEvent.findMany({ where: { finding: inScope }, orderBy: { id: 'asc' } });
  const mitigationVersions = await tx.mitigationVersion.findMany({ where: { finding: inScope }, orderBy: { id: 'asc' } });
  const mitigationEvidence = await tx.mitigationEvidence.findMany({
    where: { version: { finding: inScope } }, orderBy: [{ versionId: 'asc' }, { evidenceId: 'asc' }],
  });
  const acceptedRisks = await tx.acceptedRisk.findMany({ where: { finding: inScope }, orderBy: { id: 'asc' } });
  const stageReviews = await tx.stageReview.findMany({ where: inScope, orderBy: { id: 'asc' } });
  const seals = await tx.seal.findMany({ where: { stageReview: inScope }, orderBy: { id: 'asc' } });
  const issuedDocuments = await tx.issuedDocument.findMany({ where: inScope, omit: { pdf: true }, orderBy: { id: 'asc' } });
  const withPdf = new Set((await tx.issuedDocument.findMany({
    where: { ...inScope, pdf: { not: null } }, select: { id: true },
  })).map((d) => d.id));
  const issuedDocumentSeals = await tx.issuedDocumentSeal.findMany({
    where: { document: inScope }, orderBy: [{ documentId: 'asc' }, { sealId: 'asc' }],
  });
  const documentEvents = await tx.documentEvent.findMany({ where: { document: inScope }, orderBy: { id: 'asc' } });
  const tombstones = await tx.tombstone.findMany({ orderBy: { id: 'asc' } });
  const names = await userRefs(tx, memberships.map((m) => m.userId));

  const evidenceRow = (e: (typeof evidence)[number]): ExportEvidence => {
    const stored = row('evidence', e);
    delete stored.filename; // exported under fileName (00-master.md Review Focus 2)
    const file = e.kind === 'file' && withBytes.has(e.id) ? safeEvidenceEntryName(e.id, e.filename) : null;
    return { ...stored, id: e.id, kind: e.kind, sha256: e.sha256, fileName: e.filename, file };
  };
  const withdrawalOf = new Map<string, { on: CalendarDate; reason: string }>();
  for (const ev of documentEvents) {
    if (ev.kind === 'withdrawn' && !withdrawalOf.has(ev.documentId)) {
      withdrawalOf.set(ev.documentId, { on: ev.at.toISOString().slice(0, 10), reason: ev.reason });
    }
  }

  const versionProject = new Map(decisionVersions.map((v) => [v.id, v.projectId]));
  const findingProject = new Map(findings.map((f) => [f.id, f.projectId]));
  const mitigationProject = new Map(mitigationVersions.map((m) => [m.id, findingProject.get(m.findingId)]));
  const reviewProject = new Map(stageReviews.map((r) => [r.id, r.projectId]));
  const documentProject = new Map(issuedDocuments.map((d) => [d.id, d.projectId]));
  const attached = evidence.filter((e) => !unattachedIds.has(e.id));

  const groups = {
    metadata: byProject(metadata, (m) => m.projectId),
    decisionVersions: byProject(decisionVersions, (v) => v.projectId),
    decisionEvidence: byProject(decisionEvidence, (l) => versionProject.get(l.versionId)),
    evidence: byProject(attached, (e) => e.projectId ?? undefined),
    findings: byProject(findings, (f) => f.projectId),
    findingEvents: byProject(findingEvents, (e) => findingProject.get(e.findingId)),
    mitigationVersions: byProject(mitigationVersions, (m) => findingProject.get(m.findingId)),
    mitigationEvidence: byProject(mitigationEvidence, (l) => mitigationProject.get(l.versionId)),
    acceptedRisks: byProject(acceptedRisks, (a) => findingProject.get(a.findingId)),
    stageReviews: byProject(stageReviews, (r) => r.projectId),
    seals: byProject(seals, (s) => reviewProject.get(s.stageReviewId)),
    issuedDocuments: byProject(issuedDocuments, (d) => d.projectId),
    issuedDocumentSeals: byProject(issuedDocumentSeals, (s) => documentProject.get(s.documentId)),
    documentEvents: byProject(documentEvents, (e) => documentProject.get(e.documentId)),
  };
  const of = <T>(m: Map<string, T[]>, id: string): T[] => m.get(id) ?? [];

  const out: ExportProject[] = projects.map((p) => {
    const meta = of(groups.metadata, p.id)[0];
    return {
      id: p.id, name: p.name, description: p.description,
      createdAt: p.createdAt.toISOString(), archivedAt: p.archivedAt?.toISOString() ?? null,
      metadata: meta === undefined ? null : row('project_metadata', meta),
      decisionVersions: of(groups.decisionVersions, p.id).map((r) => row('decision_versions', r) as ExportRow & { id: string }),
      decisionEvidence: of(groups.decisionEvidence, p.id).map((r) => row('decision_evidence', r) as ExportRow & { versionId: string; evidenceId: string }),
      evidence: of(groups.evidence, p.id).map(evidenceRow),
      findings: of(groups.findings, p.id).map((r) => row('findings', r) as ExportRow & { id: string; decisionVersionId: string | null }),
      findingEvents: of(groups.findingEvents, p.id).map((r) => row('finding_events', r)),
      mitigationVersions: of(groups.mitigationVersions, p.id).map((r) => row('mitigation_versions', r)),
      mitigationEvidence: of(groups.mitigationEvidence, p.id).map((r) => row('mitigation_evidence', r) as ExportRow & { versionId: string; evidenceId: string }),
      acceptedRisks: of(groups.acceptedRisks, p.id).map((r) => row('accepted_risks', r)),
      stageReviews: of(groups.stageReviews, p.id).map((r) => row('stage_reviews', r)),
      seals: of(groups.seals, p.id).map((r) => row('seals', r) as ExportRow & { id: string; fingerprint: string }),
      issuedDocuments: of(groups.issuedDocuments, p.id).map((d) => ({
        ...row('issued_documents', d), id: d.id, sha256: d.sha256,
        file: withPdf.has(d.id) ? `documents/${d.id}.pdf` : null,
        withdrawn: withdrawalOf.get(d.id) ?? null,
      })),
      issuedDocumentSeals: of(groups.issuedDocumentSeals, p.id).map((r) => row('issued_document_seals', r)),
      documentEvents: of(groups.documentEvents, p.id).map((r) => row('document_events', r)),
    };
  });

  // A tombstone names the row it erased; a project export keeps those of its own rows only.
  const exportedIds = new Set<string>([
    ...projectIds, ...decisionVersions.map((r) => r.id), ...evidence.map((r) => r.id), ...findings.map((r) => r.id),
    ...findingEvents.map((r) => r.id), ...mitigationVersions.map((r) => r.id), ...acceptedRisks.map((r) => r.id),
    ...stageReviews.map((r) => r.id), ...seals.map((r) => r.id), ...issuedDocuments.map((r) => r.id), ...documentEvents.map((r) => r.id),
  ]);

  return {
    format: TEAM_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    organisation,
    scope: { projectId: scope.projectId },
    members: memberships.map((m) => {
      const ref = names.get(m.userId);
      if (ref === undefined) throw new TypeError(`team export: member ${m.userId} has no account row`);
      return { userId: m.userId, name: ref.name, role: m.role };
    }),
    projects: out,
    unattachedEvidence: evidence.filter((e) => unattachedIds.has(e.id)).map(evidenceRow),
    tombstones: tombstones.filter((t) => scope.projectId === null || exportedIds.has(t.targetId)).map((t) => row('tombstones', t)),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The ZIP on disk (ADR-C7): written from the snapshot to a temporary file, the transaction
// closed, then streamed by route 20 with no database connection held.
// ─────────────────────────────────────────────────────────────────────────────

/** Exports running in this process at once (SRS 6.3; NFR-SEC-20). A third answers 429 export_busy. */
export const MAX_RUNNING_EXPORTS = 2;
const BUSY_RETRY_SECONDS = 60;
/** The snapshot's transaction may stay open this long (Prisma's default is 5000 ms). */
const SNAPSHOT_TIMEOUT_MS = 600_000;
/** A written export not released by then is deleted and its slot freed. */
const EXPORT_LIFETIME_MS = 6 * 60 * 60 * 1000;
/** A directory of this prefix older than this, left by an earlier process, is removed at the next export. */
const STALE_DIRECTORY_MS = 24 * 60 * 60 * 1000;
const DIRECTORY_PREFIX = 'makrai-export-';

let slotsInUse = 0;
/** Directory of each written export not yet released, with the timer that deletes it after six hours. */
const written = new Map<string, NodeJS.Timeout>();

const encoder = new TextEncoder();

/**
 * Removes `makrai-export-*` directories older than 24 hours that this process does not hold: the
 * leftovers of a process that stopped before releasing its exports. Housekeeping only: an entry it
 * cannot read or remove is logged with its name and skipped, so one stuck directory cannot stop
 * every export. A directory gone between the listing and the stat was released by its owner.
 */
async function removeStaleExportDirectories(): Promise<void> {
  const root = tmpdir();
  for (const name of await readdir(root)) {
    const dir = join(root, name);
    if (!name.startsWith(DIRECTORY_PREFIX) || written.has(dir)) continue;
    try {
      if (Date.now() - (await stat(dir)).mtimeMs > STALE_DIRECTORY_MS) await rm(dir, { recursive: true, force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      console.warn(`team export: could not remove a stale export directory ${dir}`, e);
    }
  }
}

/**
 * Writes the export of the organisation (`projectId` null) or of one project to a new temporary
 * file and returns where it is, its size and the name to download it as. The file is
 * `<os.tmpdir()>/makrai-export-<random>/export.zip`, mode 0600 in a 0700 directory. Everything in
 * it, rows and files, is read in one REPEATABLE READ transaction (NFR-INT-10); evidence blobs and
 * PDFs are read one at a time, so one file's bytes are in memory at once.
 *
 * At most `MAX_RUNNING_EXPORTS` are written and not yet released; another answers
 * `RateLimitedError(60, 'export_busy')` before anything is read or written. The caller must call
 * `releaseTeamExport(path)` once the file is sent; an export not released is deleted after six
 * hours. On any error the directory is deleted and the slot freed before the error is rethrown.
 */
export async function writeTeamExport(ctx: OrgContext, actor: Actor, a: { projectId: string | null }): Promise<{ path: string; bytes: number; fileName: string }> {
  if (slotsInUse >= MAX_RUNNING_EXPORTS) throw new RateLimitedError(BUSY_RETRY_SECONDS, 'export_busy');
  slotsInUse += 1; // taken before the first await, so two requests cannot both see a free slot
  let dir: string | null = null;
  try {
    await removeStaleExportDirectories();
    dir = await mkdtemp(join(tmpdir(), DIRECTORY_PREFIX));
    const path = join(dir, 'export.zip');
    const { slug, bytes } = await withOrg(ctx, async (tx) => {
      const json = await readExportSnapshot(tx, { projectId: a.projectId });
      const { slug } = await tx.organization.findFirstOrThrow({ select: { slug: true } });
      const integrityFailure = (evidenceId: string): AppError => {
        logSecurityEvent('EVIDENCE_INTEGRITY_FAILURE', 'error', { userId: actor.userId, details: { orgId: ctx.orgId, evidenceId } });
        return new AppError(500, 'integrity_failure', 'Integrity failure');
      };
      const evidence = [...json.projects.flatMap((p) => p.evidence), ...json.unattachedEvidence];
      // A file with no bytes is only right when the operator erased them (FR-EVD-05): its tombstone is in the export.
      const erased = new Set(json.tombstones.filter((t) => t.targetTable === 'evidence' && t.field === null).map((t) => t.targetId));
      for (const e of evidence) {
        if (e.kind === 'file' && e.file === null && !erased.has(e.id)) throw integrityFailure(e.id);
      }
      const zip = openZipFile(path);
      try {
        zip.add('export.json', encoder.encode(JSON.stringify(json)));
        zip.add('README.txt', encoder.encode(README_TEXT));
        for (const e of evidence) {
          if (e.file === null) continue;
          const blob = await tx.evidenceBlob.findUnique({ where: { evidenceId: e.id }, select: { content: true } });
          // SRS 6.2: re-checked at every download. The export is one, so it fails closed before a byte is sent.
          if (blob === null || createHash('sha256').update(blob.content).digest('hex') !== e.sha256) throw integrityFailure(e.id);
          zip.add(e.file, blob.content);
        }
        for (const d of json.projects.flatMap((p) => p.issuedDocuments)) {
          if (d.file === null) continue;
          const { pdf } = await tx.issuedDocument.findUniqueOrThrow({ where: { id: d.id }, select: { pdf: true } });
          if (pdf === null) throw new TypeError(`team export: document ${d.id} lost its PDF inside one snapshot`);
          zip.add(d.file, pdf);
        }
        return { slug, bytes: zip.finish() };
      } catch (e) {
        zip.abort();
        if (e instanceof ZipLimitError) {
          // No ZIP64 in v1 (fflate writes none): refuse, with a fixed code and ids only.
          const code = e.limit === 'entries' ? 'export_entry_limit' : 'export_size_limit';
          console.error(JSON.stringify({ code, orgId: ctx.orgId, projectId: a.projectId, userId: actor.userId, at: new Date().toISOString() }));
          throw new AppError(500, code, 'Export too large');
        }
        throw e;
      }
    }, { isolationLevel: 'RepeatableRead', timeoutMs: SNAPSHOT_TIMEOUT_MS });

    logSecurityEvent('EXPORT_MADE', 'info', { userId: actor.userId, details: { orgId: ctx.orgId, projectId: a.projectId, bytes } });
    const day = new Date().toISOString().slice(0, 10);
    const fileName = `makrai-export-${slug}${a.projectId === null ? '' : `-${a.projectId.slice(0, 8)}`}-${day}.zip`;

    // Registered last: from here the slot is the release's to free, and nothing below can throw.
    const held = dir;
    const expiry = setTimeout(() => {
      // Every route path releases at the stream's end, cancel, error or the client leaving, so a
      // reclaim here means one of those did not happen: say so.
      if (!written.has(held)) return;
      console.warn(`team export: an export was not released for six hours; removing ${held}`);
      releaseTeamExport(path).catch((e: unknown) => {
        console.error(`team export: the six-hour cleanup of ${held} failed`, e);
      });
    }, EXPORT_LIFETIME_MS);
    expiry.unref();
    written.set(dir, expiry);
    return { path, bytes, fileName };
  } catch (e) {
    try {
      if (dir !== null) await rm(dir, { recursive: true, force: true });
    } catch (cleanup) {
      // The export's own error is the answer; the directory is swept after 24 hours.
      console.error(`team export: could not delete ${dir} after a failed export`, cleanup);
    } finally {
      slotsInUse -= 1;
    }
    throw e;
  }
}

/**
 * Opens a written export for reading and deletes its directory at once: the open handle keeps the
 * file readable (it is unlinked, not gone, until the handle closes), and no directory is left on
 * disk however the response ends, a body never read or cancelled included. The slot stays held
 * until `releaseTeamExport`.
 */
export async function openTeamExport(path: string): Promise<FileHandle> {
  const dir = exportDirectoryOf(path);
  const handle = await open(path, 'r');
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (e) {
    console.error(`team export: could not delete ${dir} after opening its export`, e);
  }
  return handle;
}

/** The export directory of a path `writeTeamExport` returned; refuses any other path. */
function exportDirectoryOf(path: string): string {
  const dir = dirname(path);
  if (dirname(dir) !== tmpdir() || !basename(dir).startsWith(DIRECTORY_PREFIX) || basename(path) !== 'export.zip') {
    throw new TypeError('team export: not a path writeTeamExport returned');
  }
  return dir;
}

/**
 * Deletes a written export's directory and frees its slot. Idempotent: a path already released
 * (by the stream's end, its cancel, an error or the six-hour timer) does nothing. Refuses a path
 * that is not an export file of `writeTeamExport`, so it can never delete anything else.
 */
export async function releaseTeamExport(path: string): Promise<void> {
  const dir = exportDirectoryOf(path);
  const expiry = written.get(dir);
  if (expiry === undefined) return;
  written.delete(dir);
  clearTimeout(expiry);
  try {
    await rm(dir, { recursive: true, force: true });
  } finally {
    slotsInUse -= 1;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account deletion (FR-EXP-03, FR-EXP-04; route 39). The person leaves every organisation and
// their account is scrubbed; the records they entered stay with the organisations, and their
// acceptance rows stay as they are (no UPDATE or DELETE on consent_records).
// ─────────────────────────────────────────────────────────────────────────────

export const DELETE_PHRASE = 'DELETE MY ACCOUNT';
/** The S-21 field texts (SRS line 2389). */
export const WRONG_PASSWORD = 'The password is not right.';
export const WRONG_PHRASE = 'Type DELETE MY ACCOUNT exactly.';
/** S-21's refusal for the platform administrator's own account (owner copy, queued for the owner). */
export const PLATFORM_ADMIN_ACCOUNT = "The platform administrator's account cannot be deleted here. Ask the operator to hand the role over first.";
/** M-38 (SRS line 2580). */
export const lastActiveOwnerMessage = (organisation: string): string =>
  `You are the only owner of ${organisation} with an active account. Make someone else an owner first, then delete your account.`;

function lastActiveOwner(organisation: string): AppError {
  return new AppError(409, 'last_active_owner', lastActiveOwnerMessage(organisation), { organisation });
}

/**
 * Deletes the account `userId` (contract signature). In this order:
 * 0. the platform administrator's account is refused with 409 `platform_admin_account` (owner decision);
 * 1. the typed phrase, then the password against the stored hash (each a 422 on its field, and
 *    nothing changes);
 * 2. phase 1: `lastActiveOwnerOf` names any organisation where the person is an owner and no other
 *    owner's account is active; the first such name answers 409 `last_active_owner` (M-38);
 * 3. phase 2, one transaction per organisation, owner memberships first: the owner rows are locked
 *    `FOR UPDATE`, the owners whose account is active are counted again, the person is refused as in
 *    phase 1 if they would be the last, else their membership is deleted and one `member_left` row
 *    written in the same transaction (FR-ORG-09). A co-owner deleting at the same moment waits on the
 *    lock and then sees this deletion;
 * 4. the account is scrubbed (name 'Deleted user', email replaced, an unusable password, inactive,
 *    every session ended by the epoch) and one ACCOUNT_DELETED is logged with the id only.
 * Residual (as before, D-119 in docs/DEFERRED_REGISTER.md): organisations are separate transactions,
 * so a refusal in phase 2 leaves the memberships already removed in earlier organisations removed.
 */
export async function deleteAccount(userId: string, a: { password: string; phrase: string }): Promise<void> {
  const account = await identityDb.user.findUnique({ where: { id: userId }, select: { passwordHash: true, role: true } });
  // Owner decision: there is exactly one platform administrator in production, and deleting it would leave none
  // (FR-ORG-03). The operator hands the role over instead; nothing is checked or changed here.
  if (account?.role === 'admin') throw new AppError(409, 'platform_admin_account', PLATFORM_ADMIN_ACCOUNT);
  if (a.phrase !== DELETE_PHRASE) throw new ValidationFailed([{ field: 'phrase', message: WRONG_PHRASE }]);
  if (account === null || !(await compare(a.password, account.passwordHash))) {
    throw new ValidationFailed([{ field: 'password', message: WRONG_PASSWORD }]);
  }

  const [blocked] = await lastActiveOwnerOf(userId);
  if (blocked !== undefined) throw lastActiveOwner(blocked);

  const memberships = (await membershipsForUser(userId))
    .sort((x, y) => Number(y.role === 'owner') - Number(x.role === 'owner'));
  for (const m of memberships) {
    const ctx = await requireOrgContextFor(userId, m.org.slug, 'member:leave');
    await withOrg(ctx, async (tx) => {
      if (m.role === 'owner') {
        const owners = await tx.$queryRaw<{ userId: string }[]>`
          SELECT "userId" FROM memberships WHERE role = 'owner' AND status = 'active' FOR UPDATE`;
        const others = owners.map((o) => o.userId).filter((id) => id !== userId);
        const active = others.length === 0 ? 0 : await identityDb.user.count({ where: { id: { in: others }, isActive: true } });
        if (active === 0) throw lastActiveOwner(m.org.name);
      }
      await tx.membership.deleteMany({ where: { userId } });
      await recordOrgEvent(tx, { actorId: userId, actorRole: m.role, action: 'member_left', targetUserId: userId });
    });
  }

  // An unusable password: random bytes nobody knows, hashed at the app's cost (the account is also inactive).
  await scrubUserOnDeactivation(userId, await hash(randomBytes(32).toString('hex'), 12));
  logSecurityEvent('ACCOUNT_DELETED', 'warn', { userId });
}

// ─────────────────────────────────────────────────────────────────────────────
// Personal export (FR-EXP-02, NFR-PRIV-08, SRS 6.4; route 38). The person's own rows from the
// identity lane, and a list of the record rows they entered or were named in, in the
// organisations they are a member of now, by organisation, type, id and date: no record text.
// ─────────────────────────────────────────────────────────────────────────────

export const PERSONAL_EXPORT_FORMAT = 'makrai.personal-export/1';
/** The value of the two hashes that never leave the server (owner question B17, contract Q11). */
const WITHHELD = 'withheld';

type Role = PersonalExportItem['roles'][number];
type ItemSource = {
  type: PersonalItemType; table: string; date: string;
  /** Columns that name the person, each with the role it gives. */
  people: ReadonlyArray<[string, Role]>;
  /** The row's kind or action, where the table has one. */
  kind?: string;
  /** An invitation names the person by address: `invited`, with the address and acceptance as their own fields. */
  byEmail?: { column: string; own: readonly string[] };
};
/** Each table that names a person in a row, its time column, and the columns that name the person with their roles. */
const ITEM_SOURCES: readonly ItemSource[] = [
  { type: 'decision_version', table: 'decision_versions', date: 'receivedAt', people: [['enteredById', 'entered'], ['decidedByUserId', 'decided']] },
  { type: 'evidence', table: 'evidence', date: 'uploadedAt', people: [['uploadedById', 'entered']] },
  { type: 'finding', table: 'findings', date: 'raisedAt', people: [['raisedById', 'entered']] },
  { type: 'finding_event', table: 'finding_events', date: 'at', people: [['byId', 'entered']] },
  { type: 'mitigation_version', table: 'mitigation_versions', date: 'receivedAt', people: [['enteredById', 'entered'], ['ownerUserId', 'owns']] },
  { type: 'accepted_risk', table: 'accepted_risks', date: 'receivedAt', people: [['enteredById', 'entered'], ['acceptedByUserId', 'accepted']] },
  { type: 'stage_review', table: 'stage_reviews', date: 'openedAt', people: [['openedById', 'entered']] },
  { type: 'seal', table: 'seals', date: 'sealedAt', people: [['sealedById', 'entered']] },
  { type: 'issued_document', table: 'issued_documents', date: 'issuedAt', people: [['issuedById', 'entered']] },
  { type: 'document_event', table: 'document_events', date: 'at', people: [['byId', 'entered']] },
  { type: 'project', table: 'projects', date: 'createdAt', people: [['createdById', 'entered']] },
  { type: 'document_draft_field', table: 'document_draft_fields', date: 'updatedAt', people: [['updatedById', 'entered']], kind: 'documentType' },
  { type: 'organisation_event', table: 'organisation_events', date: 'at', people: [['actorId', 'acted'], ['targetUserId', 'named']], kind: 'action' },
  { type: 'request_receipt', table: 'request_receipts', date: 'createdAt', people: [['actorUserId', 'entered']], kind: 'route' },
  { type: 'invitation', table: 'invitations', date: 'createdAt', people: [['invitedById', 'entered']], kind: 'kind', byEmail: { column: 'email', own: ['email', 'acceptedAt'] } },
  { type: 'organisation_agreement', table: 'organization_agreements', date: 'recordedAt', people: [['recordedById', 'entered']], kind: 'agreementVersion' },
];
/** The tables personalExport reads for items (NFR-PRIV-08's test compares them with the allow-list). */
export const PERSONAL_ITEM_TABLES: readonly string[] = ITEM_SOURCES.map((s) => s.table);

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * Ids, times, kinds and the person's own fields only, of the rows of `source` that name `userId` (or, for an
 * invitation, `email`) — never another person's id, address or the row's text.
 */
async function itemRows(tx: TenantTx, source: ItemSource, userId: string, email: string): Promise<Array<{ id: string; date: Date; roles: Role[]; kind?: string; own?: Record<string, string | null> }>> {
  // The table and column names are this module's constants, never input; the person is a bound parameter.
  const cases = source.people.map(([column]) => `"${column}" = $1`);
  if (source.byEmail) cases.push(`lower("${source.byEmail.column}") = lower($2)`);
  const ownColumns = source.byEmail?.own ?? [];
  const columns = [
    '"id"', `"${source.date}" AS "date"`, ...(source.kind ? [`"${source.kind}"::text AS "kind"`] : []),
    ...cases.map((c, i) => `(${c}) AS "r${i}"`), ...ownColumns.map((c, i) => `"${c}" AS "o${i}"`),
  ];
  const rows = await tx.$queryRawUnsafe<Array<Record<string, unknown>>>(
    `SELECT ${columns.join(', ')} FROM "${source.table}" WHERE ${cases.join(' OR ')} ORDER BY "${source.date}", "id"`,
    ...(source.byEmail ? [userId, email] : [userId]),
  );
  const roleOf: Role[] = [...source.people.map(([, role]) => role), ...(source.byEmail ? ['invited' as const] : [])];
  return rows.map((r) => {
    const roles = roleOf.filter((_, i) => r[`r${i}`] === true);
    const invited = source.byEmail !== undefined && r[`r${source.people.length}`] === true;
    const own = invited
      ? Object.fromEntries(ownColumns.map((c, i) => { const v = r[`o${i}`]; return [c, v instanceof Date ? v.toISOString() : (v as string | null)]; }))
      : undefined;
    return {
      id: r.id as string, date: r.date as Date, roles,
      ...(source.kind ? { kind: r.kind as string } : {}),
      ...(own ? { own } : {}),
    };
  });
}

/**
 * The personal export of `userId` (contract signature): format `makrai.personal-export/1`.
 * - `account`: the account's personal columns (the users rows of the NFR-PRIV-01 allow-list),
 *   with `passwordHash` as 'withheld'. The voided research columns are not read (FR-RES-01).
 * - `memberships`: current active memberships, with organisation and role and when joined.
 * - `acceptances`: every consent_records row of the account, void ones included.
 * - `signIn`: known devices, and password reset requests with `tokenHash` as 'withheld'.
 * - `items`: per current membership, one `withOrg` reading only ids, times and person columns of
 *   the ten record tables; a row naming the person in two columns is one item with both roles.
 */
export async function personalExport(userId: string): Promise<PersonalExport> {
  const user = await identityDb.user.findUniqueOrThrow({ where: { id: userId }, select: {
    id: true, email: true, name: true, role: true, isActive: true, mustChangePassword: true,
    termsAccepted: true, termsAcceptedAt: true, createdAt: true, updatedAt: true,
    failedLoginAttempts: true, lockedUntil: true, sessionEpoch: true, lastActiveOrgId: true, reminderEmails: true,
  } });
  const acceptances = await identityDb.consentRecord.findMany({ where: { userId }, orderBy: { grantedAt: 'asc' } });
  const knownDevices = await identityDb.knownDevice.findMany({ where: { userId }, orderBy: { lastSeenAt: 'asc' } });
  const resets = await identityDb.passwordResetToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
  const memberships = await membershipsForUser(userId);

  const items: PersonalExportItem[] = [];
  for (const m of memberships) {
    const ctx = await requireOrgContextFor(userId, m.org.slug, 'record:read');
    const found = await withOrg(ctx, async (tx) => {
      const out: PersonalExportItem[] = [];
      for (const source of ITEM_SOURCES) {
        for (const r of await itemRows(tx, source, userId, user.email)) {
          out.push({
            orgId: m.orgId, organisation: m.org.name, type: source.type, id: r.id, date: r.date.toISOString(), roles: r.roles,
            ...(r.kind !== undefined ? { kind: r.kind } : {}), ...(r.own ? { own: r.own } : {}),
          });
        }
      }
      return out;
    });
    items.push(...found);
  }

  return {
    format: PERSONAL_EXPORT_FORMAT,
    exportedAt: new Date().toISOString(),
    account: {
      ...user, termsAcceptedAt: iso(user.termsAcceptedAt), createdAt: iso(user.createdAt), updatedAt: iso(user.updatedAt),
      lockedUntil: iso(user.lockedUntil), passwordHash: WITHHELD,
    },
    memberships: memberships.map((m) => ({ orgId: m.orgId, organisation: m.org.name, role: m.role, joinedAt: m.createdAt.toISOString() })),
    acceptances: acceptances.map((a) => ({ ...a, grantedAt: a.grantedAt.toISOString(), voidedAt: iso(a.voidedAt) })),
    signIn: {
      knownDevices: knownDevices.map((d) => ({ ...d, lockedUntil: iso(d.lockedUntil), lastSeenAt: d.lastSeenAt.toISOString() })),
      passwordResets: resets.map((p) => ({
        ...p, tokenHash: WITHHELD, expiresAt: p.expiresAt.toISOString(), usedAt: iso(p.usedAt), voidedAt: iso(p.voidedAt), createdAt: p.createdAt.toISOString(),
      })),
    },
    items,
  };
}

/**
 * About how many bytes the team export of the scope holds (S-20, M-37 "about <size>"): the stored size of
 * every evidence file whose bytes are still held and of every issued document with its PDF. export.json and
 * README.txt add a little; the estimate leaves them out.
 */
export async function estimateTeamExport(ctx: OrgContext, projectId: string | null): Promise<number> {
  return withOrg(ctx, async (tx) => {
    const scope = projectId === null ? {} : { projectId };
    const [evidence, documents] = await Promise.all([
      tx.evidence.aggregate({ where: { ...scope, kind: 'file', blob: { isNot: null } }, _sum: { byteSize: true } }),
      tx.issuedDocument.aggregate({ where: { ...scope, pdf: { not: null } }, _sum: { byteSize: true } }),
    ]);
    return (evidence._sum.byteSize ?? 0) + (documents._sum.byteSize ?? 0);
  });
}
