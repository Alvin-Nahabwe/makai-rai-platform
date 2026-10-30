import { createHash, randomUUID } from 'node:crypto';
import { hash } from 'bcryptjs';
import type { OrgRole } from '@prisma/client';
import type { OrgContext } from '../../lib/data/tenant';
import type { Stage, StoredDecisionStatus, ScopeAnswer, Decider, DeclaredDate, FindingSource,
  MitigationStatus, MitigationKind, DocumentType, CalendarDate } from '../../types/record';
import { testDb } from './db';
import { stubAcceptanceRows } from './legalStub';

/**
 * The record fixture builder of 00-contract.md, Test harness API (K0a): one organisation with a
 * member of each role, and the v0.6.0 record rows, written through `testDb`, the owner role
 * `makrai` (a superuser in the test container), so row-level security does not apply and the
 * triggers do: received times are the database's, append-only rows cannot be changed, and
 * findingSeq is checked across a finding's events, mitigation versions and accepted risks.
 *
 * Tests set up the records they need here and read them with their own unit's code (contract,
 * "Fixture setup, not another unit's service"). Nothing here calls a service; nothing under
 * app/, lib/ or components/ may import this file (NFR-PRIV-05; record-fixture.test.ts).
 */

export type FixtureTextSource = (field: string, seq: number) => string;
export interface FixtureAccount { userId: string; email: string; name: string; password: string }
export interface FixtureMember extends FixtureAccount { role: OrgRole; orgId: string; orgSlug: string }
export interface OrgFixture {
  org: { id: string; slug: string; name: string };
  members: Record<OrgRole, FixtureMember>;
  text: FixtureTextSource;
}
export interface BuildOrgOptions {
  label?: string;
  text?: FixtureTextSource;                     // default: plain 'Fixture <field> <seq>'
  acceptances?: 'v1' | 'pre-v1' | 'none';       // default 'v1' (rows of fixtureLegalTexts()); 'pre-v1' = version '1.0', no hash
  withAgreement?: boolean;                       // default true
}

/** Not a secret: every fixture account shares it, so a sign-in step needs one known plaintext. */
const FIXTURE_ACCOUNT_PASSWORD = 'FixturePass123!';
const ROLES: readonly OrgRole[] = ['owner', 'admin', 'assessor', 'reviewer', 'viewer'];
const plainText: FixtureTextSource = (field, seq) => `Fixture ${field} ${seq}`;
const sha256Hex = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const runId = () => `${Date.now().toString(36)}-${randomUUID().slice(0, 6)}`;

let passwordHash: Promise<string> | undefined;
/** One bcrypt hash per process (cost 12, as the app's), shared by every fixture account. */
function fixturePasswordHash(): Promise<string> {
  passwordHash ??= hash(FIXTURE_ACCOUNT_PASSWORD, 12);
  return passwordHash;
}

let seq = 0;
const nextSeq = () => ++seq;

async function writeAcceptances(userId: string, acceptances: 'v1' | 'pre-v1' | 'none'): Promise<void> {
  if (acceptances === 'none') return;
  if (acceptances === 'v1') {
    await testDb.consentRecord.createMany({ data: stubAcceptanceRows(userId) });
    return;
  }
  await testDb.consentRecord.createMany({ data: (['terms_of_service', 'privacy_policy'] as const).map((consentType) =>
    ({ userId, consentType, version: '1.0', granted: true })) });
}

/** An account, with its acceptances; never a platform administrator unless `admin`. */
async function fixtureAccount(a: { email: string; name: string; admin?: boolean; acceptances: 'v1' | 'pre-v1' | 'none' }): Promise<FixtureAccount> {
  const user = await testDb.user.create({
    data: { email: a.email, name: a.name, passwordHash: await fixturePasswordHash(), role: a.admin ? 'admin' : 'assessor' },
  });
  await writeAcceptances(user.id, a.acceptances);
  return { userId: user.id, email: a.email, name: a.name, password: FIXTURE_ACCOUNT_PASSWORD };
}

/** One organisation, a member of each of the five roles (FR-AUTHZ-01), and by default its agreement record (FR-ORG-05). */
export async function buildOrg(opts: BuildOrgOptions = {}): Promise<OrgFixture> {
  const label = opts.label ?? randomUUID().slice(0, 6);
  const run = runId();
  const org = await testDb.organization.create({
    data: { name: `Fixture Org ${label.toUpperCase()} ${run}`, slug: `fixture-org-${label}-${run}`.toLowerCase() },
  });
  const members = {} as Record<OrgRole, FixtureMember>;
  for (const role of ROLES) {
    const account = await fixtureAccount({
      email: `fixture-${label}-${role}-0-${run}@fixture.test`.toLowerCase(), name: `Fixture ${label} ${role} 0`,
      acceptances: opts.acceptances ?? 'v1',
    });
    await testDb.membership.create({ data: { orgId: org.id, userId: account.userId, role } });
    members[role] = { ...account, role, orgId: org.id, orgSlug: org.slug };
  }
  if (opts.withAgreement ?? true) {
    await testDb.organisationAgreement.create({ data: {
      orgId: org.id, agreementVersion: '1', textHash: sha256Hex(`agreement ${org.id}`), acceptedOn: new Date('2026-10-30T00:00:00Z'),
      controllerLegalName: `Fixture Controller ${label}`, dpContactEmail: `dpo-${label}@fixture.test`, recordedById: members.owner.userId,
    } });
  }
  return { org: { id: org.id, slug: org.slug, name: org.name }, members, text: opts.text ?? plainText };
}

/** The platform administrator: role `admin`, no membership (FR-ORG-03, NFR-SEC-04). */
export async function buildPlatformAdmin(opts: { acceptances?: 'v1' | 'none' } = {}): Promise<FixtureAccount> {
  const run = runId();
  return fixtureAccount({ email: `fixture-platform-admin-${run}@fixture.test`, name: 'Fixture Platform Admin', admin: true, acceptances: opts.acceptances ?? 'v1' });
}

/** Test-only cast, as fixture.ts does: the fixture knows the organisation and role it just made. */
export function ctxFor(fx: OrgFixture, role: OrgRole): OrgContext {
  return { orgId: fx.org.id, role } as OrgContext;
}

const member = (fx: OrgFixture, role: OrgRole | undefined, fallback: OrgRole) => fx.members[role ?? fallback];
const request = () => ({ requestId: randomUUID(), requestDigest: sha256Hex(randomUUID()) });

export async function addProject(fx: OrgFixture, opts: { name?: string; archived?: boolean; by?: OrgRole } = {}): Promise<{ id: string }> {
  const p = await testDb.project.create({ data: {
    orgId: fx.org.id, name: opts.name ?? fx.text('projectName', nextSeq()), createdById: member(fx, opts.by, 'owner').userId,
    archivedAt: opts.archived ? new Date() : null,
  } });
  return { id: p.id };
}

export async function addEvidence(fx: OrgFixture, projectId: string,
  e: { kind: 'file'; bytes?: Buffer; fileName?: string } | { kind: 'link'; url: string; label?: string | null },
  by?: OrgRole): Promise<{ id: string; sha256: string | null }> {
  const uploadedById = member(fx, by, 'assessor').userId;
  if (e.kind === 'link') {
    const row = await testDb.evidence.create({ data: { orgId: fx.org.id, projectId, kind: 'link', url: e.url, label: e.label ?? null, uploadedById, ...request() } });
    return { id: row.id, sha256: null };
  }
  const bytes = e.bytes ?? Buffer.from(`fixture evidence ${nextSeq()}`);
  const sha256 = sha256Hex(bytes);
  const row = await testDb.evidence.create({ data: {
    orgId: fx.org.id, projectId, kind: 'file', filename: e.fileName ?? 'evidence.pdf', mimeType: 'application/pdf',
    byteSize: bytes.byteLength, sha256, uploadedById, ...request(),
  } });
  await testDb.evidenceBlob.create({ data: { evidenceId: row.id, orgId: fx.org.id, content: Uint8Array.from(bytes) } });
  return { id: row.id, sha256 };
}

export interface FixtureDecision {
  stage: Stage; questionId: string; contentVersionId: string;
  status?: StoredDecisionStatus | null; scopeAnswer?: ScopeAnswer | null; optionsInPlace?: string[];
  reasonCode?: string | null; decidedBy?: Decider; declaredDate?: DeclaredDate; by?: OrgRole;
  evidenceIds?: string[]; withdrawalCode?: string | null;
}

/** 'YYYY', 'YYYY-MM' or 'YYYY-MM-DD' as the stored date and its precision (W-3 note 7). */
function declared(d: DeclaredDate): { declaredOn: Date; declaredPrecision: 'day' | 'month' | 'year' } {
  const precision = d.length === 4 ? 'year' : d.length === 7 ? 'month' : 'day';
  const full = precision === 'year' ? `${d}-01-01` : precision === 'month' ? `${d}-01` : d;
  return { declaredOn: new Date(`${full}T00:00:00Z`), declaredPrecision: precision };
}

/** A decision version numbered 1, 2, 3 per (project, question) (FR-DEC-03); the database sets receivedAt (FR-DEC-09). */
export async function addDecision(fx: OrgFixture, projectId: string, d: FixtureDecision): Promise<{ id: string; versionNumber: number }> {
  const entering = member(fx, d.by, 'assessor');
  const versionNumber = (await testDb.decisionVersion.count({ where: { orgId: fx.org.id, projectId, questionId: d.questionId } })) + 1;
  const scopeAnswer = d.scopeAnswer ?? null;
  const status = d.status !== undefined ? d.status : scopeAnswer === null ? 'done' : null;
  const row = await testDb.decisionVersion.create({ data: {
    orgId: fx.org.id, projectId, stage: d.stage, questionId: d.questionId, contentVersionId: d.contentVersionId, versionNumber,
    baseVersionNumber: versionNumber > 1 ? versionNumber - 1 : null, status, scopeAnswer, optionsInPlace: d.optionsInPlace ?? [],
    reasonCode: d.reasonCode ?? null, reason: fx.text('reason', nextSeq()),
    decidedByUserId: d.decidedBy?.kind === 'member' ? d.decidedBy.userId : null,
    decidedByRole: d.decidedBy?.kind === 'outside_role' ? d.decidedBy.role : null,
    ...(d.declaredDate ? declared(d.declaredDate) : {}),
    withdrawalCode: d.withdrawalCode ?? null, enteredById: entering.userId, enteredByRole: entering.role, ...request(),
  } });
  if (d.evidenceIds?.length) {
    await testDb.decisionEvidence.createMany({ data: d.evidenceIds.map((evidenceId) => ({ orgId: fx.org.id, versionId: row.id, evidenceId })) });
  }
  return { id: row.id, versionNumber };
}

export async function addFinding(fx: OrgFixture, projectId: string,
  f: { stage: Stage; source: FindingSource; questionId?: string | null; decisionVersionId?: string | null; riskArea?: string | null; by?: OrgRole }): Promise<{ id: string }> {
  const n = nextSeq();
  const row = await testDb.finding.create({ data: {
    orgId: fx.org.id, projectId, stage: f.stage, source: f.source, questionId: f.questionId ?? null,
    decisionVersionId: f.decisionVersionId ?? null, riskArea: f.riskArea ?? null,
    title: fx.text('title', n), description: fx.text('description', n), raisedById: member(fx, f.by, 'assessor').userId, ...request(),
  } });
  return { id: row.id };
}

/** The next findingSeq of a finding across its three tables (the trigger checks the same, 5.3 item 11). */
async function nextFindingSeq(orgId: string, findingId: string): Promise<number> {
  const [{ n }] = await testDb.$queryRaw<{ n: number }[]>`SELECT (coalesce(max(s), 0) + 1)::int AS n FROM (
    SELECT "findingSeq" s FROM finding_events WHERE "orgId" = ${orgId} AND "findingId" = ${findingId}
    UNION ALL SELECT "findingSeq" FROM mitigation_versions WHERE "orgId" = ${orgId} AND "findingId" = ${findingId}
    UNION ALL SELECT "findingSeq" FROM accepted_risks WHERE "orgId" = ${orgId} AND "findingId" = ${findingId}) x`;
  return n;
}

export async function addFindingEvent(fx: OrgFixture, findingId: string, e: { kind: 'reopened' | 'withdrawn'; by?: OrgRole }): Promise<{ id: string; findingSeq: number }> {
  const findingSeq = await nextFindingSeq(fx.org.id, findingId);
  const row = await testDb.findingEvent.create({ data: {
    orgId: fx.org.id, findingId, kind: e.kind, reason: fx.text('reason', nextSeq()), byId: member(fx, e.by, 'owner').userId, findingSeq, ...request(),
  } });
  return { id: row.id, findingSeq };
}

export async function addMitigationVersion(fx: OrgFixture, findingId: string,
  m: { mitigationId?: string; status: MitigationStatus; kind?: MitigationKind; owner: OrgRole; dueDate: CalendarDate; by?: OrgRole; evidenceIds?: string[] }):
  Promise<{ id: string; mitigationId: string; versionNumber: number; findingSeq: number }> {
  const mitigationId = m.mitigationId ?? randomUUID();
  const versionNumber = (await testDb.mitigationVersion.count({ where: { orgId: fx.org.id, mitigationId } })) + 1;
  const findingSeq = await nextFindingSeq(fx.org.id, findingId);
  const entering = member(fx, m.by, 'assessor');
  const n = nextSeq();
  const row = await testDb.mitigationVersion.create({ data: {
    orgId: fx.org.id, findingId, mitigationId, versionNumber, baseVersionNumber: versionNumber > 1 ? versionNumber - 1 : null,
    what: fx.text('what', n), ownerUserId: fx.members[m.owner].userId, dueDate: new Date(`${m.dueDate}T00:00:00Z`), status: m.status,
    kind: m.kind ?? 'action', closureNote: m.status === 'done' ? fx.text('closureNote', n) : null,
    cancelReason: m.status === 'cancelled' ? fx.text('cancelReason', n) : null,
    enteredById: entering.userId, enteredByRole: entering.role, findingSeq, ...request(),
  } });
  if (m.evidenceIds?.length) {
    await testDb.mitigationEvidence.createMany({ data: m.evidenceIds.map((evidenceId) => ({ orgId: fx.org.id, versionId: row.id, evidenceId })) });
  }
  return { id: row.id, mitigationId, versionNumber, findingSeq };
}

export async function addAcceptedRisk(fx: OrgFixture, findingId: string,
  a: { acceptedBy?: Decider; lookAgainOn?: CalendarDate | null; by?: OrgRole }): Promise<{ id: string; findingSeq: number }> {
  const findingSeq = await nextFindingSeq(fx.org.id, findingId);
  const acceptedBy: Decider = a.acceptedBy ?? { kind: 'member', userId: fx.members.owner.userId };
  const accepter = acceptedBy.kind === 'member' ? ROLES.find((r) => fx.members[r].userId === acceptedBy.userId) ?? null : null;
  const entering = member(fx, a.by, 'owner');
  const n = nextSeq();
  const row = await testDb.acceptedRisk.create({ data: {
    orgId: fx.org.id, findingId,
    acceptedByUserId: acceptedBy.kind === 'member' ? acceptedBy.userId : null,
    acceptedByRole: acceptedBy.kind === 'outside_role' ? acceptedBy.role : null,
    accepterRole: accepter, reason: fx.text('reason', n), lookAgainNote: a.lookAgainOn ? fx.text('lookAgainNote', n) : null,
    lookAgainOn: a.lookAgainOn ? new Date(`${a.lookAgainOn}T00:00:00Z`) : null,
    enteredById: entering.userId, enteredByRole: entering.role, findingSeq, ...request(),
  } });
  return { id: row.id, findingSeq };
}

export async function addStageReview(fx: OrgFixture, projectId: string, r: { stage: Stage; preparedFor?: string | null; by?: OrgRole }): Promise<{ id: string; numberInStage: number }> {
  const numberInStage = (await testDb.stageReview.count({ where: { orgId: fx.org.id, projectId, stage: r.stage } })) + 1;
  const row = await testDb.stageReview.create({ data: {
    orgId: fx.org.id, projectId, stage: r.stage, numberInStage, preparedFor: r.preparedFor ?? null,
    openedById: member(fx, r.by, 'owner').userId, ...request(),
  } });
  return { id: row.id, numberInStage };
}

/** A seal row over the given bytes (default `{}`) and their SHA-256; a test that needs a real manifest calls REV-a's sealStageReview. */
export async function addSealRow(fx: OrgFixture, reviewId: string, s: { manifest?: Buffer; contentVersionId?: string; by?: OrgRole } = {}): Promise<{ id: string; sealNumber: number; fingerprint: string }> {
  const manifest = s.manifest ?? Buffer.from('{}');
  const fingerprint = sha256Hex(manifest);
  const sealNumber = (await testDb.seal.count({ where: { orgId: fx.org.id, stageReviewId: reviewId } })) + 1;
  const contentVersionId = s.contentVersionId
    ?? (await testDb.frameworkVersion.findFirstOrThrow({ orderBy: { publishedAt: 'desc' }, select: { id: true } })).id;
  const sealer = member(fx, s.by, 'owner');
  const row = await testDb.seal.create({ data: {
    orgId: fx.org.id, stageReviewId: reviewId, sealNumber, format: 'makrai.seal/1', contentVersionId, manifest: Uint8Array.from(manifest), fingerprint,
    sealedById: sealer.userId, sealedByRole: sealer.role, ...request(),
  } });
  return { id: row.id, sealNumber, fingerprint };
}

let documentSeq = 0;
/** An issued document of the review's project, its home seal the first of `sealIds`; issuedAt a whole database second (gap G065). */
export async function addIssuedDocument(fx: OrgFixture, reviewId: string, d: { documentType: DocumentType; sealIds: string[]; pdf?: Buffer; by?: OrgRole }): Promise<{ id: string; sha256: string }> {
  if (d.sealIds.length === 0) throw new TypeError('addIssuedDocument: at least one seal (the home seal)');
  const review = await testDb.stageReview.findUniqueOrThrow({ where: { id: reviewId }, select: { projectId: true } });
  const pdf = d.pdf ?? Buffer.from(`%PDF-fixture ${nextSeq()}`);
  const sha256 = sha256Hex(pdf);
  // A distinct whole second per document, within the 120 s the issue trigger allows.
  const back = documentSeq++ % 100;
  const [{ issuedAt }] = await testDb.$queryRaw<{ issuedAt: Date }[]>`SELECT date_trunc('second', clock_timestamp()) - make_interval(secs => ${back}) AS "issuedAt"`;
  const row = await testDb.issuedDocument.create({ data: {
    orgId: fx.org.id, projectId: review.projectId, stageReviewId: reviewId, sealId: d.sealIds[0], documentType: d.documentType,
    templateVersion: '1', typedFields: [], pdf: Uint8Array.from(pdf), plainText: fx.text('plainText', nextSeq()), sha256, byteSize: pdf.byteLength,
    issuedById: member(fx, d.by, 'owner').userId, issuedAt, ...request(),
  } });
  await testDb.issuedDocumentSeal.createMany({ data: [...new Set(d.sealIds)].map((sealId) => ({ orgId: fx.org.id, documentId: row.id, sealId })) });
  return { id: row.id, sha256 };
}
