import type { OrgRole } from '@prisma/client';
import type { CalendarDate, UtcInstant } from '../../types/record';
import { AppError } from '../http/errors';
import { safeEvidenceEntryName } from '../export/zip';
import { unattachedEvidenceIn } from './evidence';
import type { TenantTx } from './tenant';
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
