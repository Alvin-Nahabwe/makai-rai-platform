import { createHash, randomUUID } from 'node:crypto';
import type { OrgRole } from '@prisma/client';
import type { Stage } from '@/types/record';
import type { ManifestDecision, ManifestEvidence, ManifestFinding, SealManifestV1 } from '@/types/seal';
import { canonicalJson } from '@/lib/integrity/canonical.mjs';
import { deriveFindingState } from '@/lib/findings/state';
import { testDb } from './db';
import type { OrgFixture } from './recordFixture';

/**
 * A seal row for a document test (DOC-a; test-only). It reads the named decision-version and finding rows and builds a
 * `SealManifestV1` of the contract's shape whose entries carry those ids and the rows' own values, every digest field
 * `{ d: '0' * 64 }`, then stores `canonicalJson(manifest)` as the seal's bytes with their SHA-256 as the fingerprint and the
 * manifest naming the row's own id, so `trustedManifest` accepts it. It is not REV-a's byte format and no test here runs
 * `checkSealRows` on it; the end-to-end test seals through REV-a's service.
 *
 * The row is inserted here and not through `addSealRow`, because that helper creates the id itself and the manifest has to
 * name it; the columns are the same.
 */

const ZERO = { d: '0'.repeat(64) };
const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const declaredDate = (on: Date | null, precision: string | null): string | null => {
  if (on === null || precision === null) return null;
  const day = on.toISOString().slice(0, 10);
  return precision === 'year' ? day.slice(0, 4) : precision === 'month' ? day.slice(0, 7) : day;
};

export async function sealFixture(
  fx: OrgFixture, reviewId: string,
  a: { projectId: string; stage: Stage; contentVersionId: string; decisionVersionIds: string[]; findingIds?: string[]; by?: OrgRole; derived?: Array<{ question: string; from: string }> },
): Promise<{ id: string; sealNumber: number; fingerprint: string }> {
  const sealId = randomUUID();
  const sealer = fx.members[a.by ?? 'owner'];
  const review = await testDb.stageReview.findUniqueOrThrow({ where: { id: reviewId } });
  const content = await testDb.frameworkVersion.findUniqueOrThrow({ where: { id: a.contentVersionId } });
  const sealNumber = (await testDb.seal.count({ where: { orgId: fx.org.id, stageReviewId: reviewId } })) + 1;

  const versions = await testDb.decisionVersion.findMany({
    where: { orgId: fx.org.id, id: { in: a.decisionVersionIds } }, include: { evidence: true }, orderBy: { questionId: 'asc' },
  });
  const evidenceRows = await testDb.evidence.findMany({ where: { orgId: fx.org.id, id: { in: versions.flatMap((v) => v.evidence.map((e) => e.evidenceId)) } } });
  const evidenceEntry = (id: string): ManifestEvidence => {
    const e = evidenceRows.find((r) => r.id === id) ?? { id, kind: 'file', sha256: null };
    return { id, kind: e.kind as 'file' | 'link', sha256: e.sha256 ?? null, fileName: ZERO, url: null, label: null };
  };
  const decisions: ManifestDecision[] = versions.map((v) => ({
    question: v.questionId, id: v.id, number: v.versionNumber, content: { semver: content.semver, contentHash: content.contentHash },
    status: v.status as never, scopeAnswer: v.scopeAnswer as never, optionsInPlace: [...v.optionsInPlace],
    decidedBy: { userId: v.decidedByUserId, outsideRole: v.decidedByRole as never },
    declaredDate: declaredDate(v.declaredOn, v.declaredPrecision) ?? '', declaredPrecision: (v.declaredPrecision ?? 'day') as never,
    reasonCode: v.reasonCode, enteredBy: v.enteredById, enteredByRole: v.enteredByRole, receivedAt: v.receivedAt.toISOString(),
    reason: ZERO, evidence: v.evidence.map((e) => evidenceEntry(e.evidenceId)),
  }));

  for (const d of a.derived ?? []) decisions.push({ question: d.question, derived: 'not_applicable_gate', from: d.from, content: { semver: content.semver, contentHash: content.contentHash } });
  const findings: ManifestFinding[] = [];
  for (const id of a.findingIds ?? []) {
    const f = await testDb.finding.findUniqueOrThrow({ where: { id } });
    const events = await testDb.findingEvent.findMany({ where: { findingId: id }, orderBy: { findingSeq: 'asc' } });
    const all = await testDb.mitigationVersion.findMany({ where: { findingId: id }, include: { evidence: true }, orderBy: { findingSeq: 'asc' } });
    const latest = new Map<string, (typeof all)[number]>();
    for (const m of all) if ((latest.get(m.mitigationId)?.versionNumber ?? 0) < m.versionNumber) latest.set(m.mitigationId, m);
    const risks = await testDb.acceptedRisk.findMany({ where: { findingId: id }, orderBy: { findingSeq: 'asc' } });
    const risk = risks.length === 0 ? null : risks[risks.length - 1];
    findings.push({
      id, source: f.source as never, question: f.questionId, decisionVersion: f.decisionVersionId, riskArea: f.riskArea,
      title: ZERO, description: ZERO,
      state: deriveFindingState({
        source: f.source as never, events: events.map((e) => ({ kind: e.kind as never, findingSeq: e.findingSeq })),
        currentMitigations: [...latest.values()].map((m) => ({ status: m.status as never, findingSeq: m.findingSeq })),
        acceptedRisks: risks.map((r) => ({ findingSeq: r.findingSeq })),
      }),
      events: events.map((e) => ({ id: e.id, kind: e.kind as never, findingSeq: e.findingSeq, by: e.byId, reason: ZERO })),
      mitigations: [...latest.values()].map((m) => ({
        versionId: m.id, mitigationId: m.mitigationId, number: m.versionNumber, findingSeq: m.findingSeq, kind: m.kind as never,
        status: m.status as never, owner: m.ownerUserId, dueDate: m.dueDate.toISOString().slice(0, 10), followsControl: m.followsControl,
        what: ZERO, changeNote: null, closureNote: m.closureNote === null ? null : ZERO, cancelReason: null,
        enteredBy: m.enteredById, enteredByRole: m.enteredByRole, evidence: m.evidence.map((e) => evidenceEntry(e.evidenceId)),
      })),
      acceptedRisk: risk === null ? null : {
        id: risk.id, findingSeq: risk.findingSeq,
        acceptedBy: { userId: risk.acceptedByUserId, outsideRole: risk.acceptedByRole as never }, accepterRole: risk.accepterRole,
        enteredBy: risk.enteredById, enteredByRole: risk.enteredByRole, reason: ZERO,
        lookAgainNote: risk.lookAgainNote === null ? null : ZERO, lookAgainDate: risk.lookAgainOn === null ? null : risk.lookAgainOn.toISOString().slice(0, 10),
      },
    });
  }

  const manifest: SealManifestV1 = {
    format: 'makrai.seal/1',
    seal: {
      id: sealId, number: sealNumber, stageReviewId: reviewId, stage: a.stage, preparedFor: review.preparedFor === null ? null : ZERO,
      sealedBy: sealer.userId, sealedByRole: sealer.role, sealedAt: new Date().toISOString(),
    },
    project: a.projectId, organisation: fx.org.id, content: { semver: content.semver, contentHash: content.contentHash }, decisions, findings,
  };
  const bytes = Buffer.from(canonicalJson(manifest), 'utf8');
  const row = await testDb.seal.create({ data: {
    id: sealId, orgId: fx.org.id, stageReviewId: reviewId, sealNumber, format: 'makrai.seal/1', contentVersionId: a.contentVersionId,
    manifest: Uint8Array.from(bytes), fingerprint: sha256Hex(bytes), sealedById: sealer.userId, sealedByRole: sealer.role,
    requestId: randomUUID(), requestDigest: sha256Hex(Buffer.from(randomUUID())),
  } });
  return { id: row.id, sealNumber, fingerprint: row.fingerprint };
}
