import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createElement } from 'react';
import { createHash, randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SaveDecisionRequest } from '@/types/api';
import { VersionEvidenceList } from '@/components/evidence/VersionEvidenceList';
import { decisionHistory, saveDecision } from '@/lib/data/decisions';
import { createFileEvidence, createLinkEvidence, readEvidenceForDownload } from '@/lib/data/evidence';
import { requestDigest } from '@/lib/data/idempotency';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

const PDF_BYTES = Buffer.from('%PDF-1.4\ncarry forward fixture\n%%EOF');

let fx: OrgFixture;
let p: { id: string };

beforeEach(async () => {
  await resetDb();
  await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  p = await addProject(fx);
});

const ctxA = () => ctxFor(fx, 'assessor');
const assessor = () => ({ userId: fx.members.assessor.userId, role: 'assessor' as const });

/** A SaveDecisionRequest for Q-PP-01 of the fixture bundle. */
const decision = (o: Partial<SaveDecisionRequest>): SaveDecisionRequest => ({
  requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: `Fixture reason ${randomUUID()}`, decidedBy: { kind: 'member', userId: fx.members.assessor.userId },
  declaredDate: '2026-10-12', evidenceIds: [], ...o,
});
const save = (d: SaveDecisionRequest) => saveDecision(ctxA(), assessor(), { ...d, projectId: p.id }, requestDigest({ path: { id: p.id }, body: d }));

describe('evidence across decision versions', () => {
  it('FR-EVD-04: version 2 saved with the file removed leaves version 1 downloadable and lists none', async () => {
    const fileName = 'v1.pdf';
    const file = (await createFileEvidence(ctxA(), assessor(), { projectId: p.id, fileName, bytes: PDF_BYTES, requestId: randomUUID() },
      requestDigest({ path: { id: p.id }, body: { kind: 'file', fileName, sha256: createHash('sha256').update(PDF_BYTES).digest('hex') } }))).value;
    await save(decision({ baseVersionNumber: null, evidenceIds: [file.id] }));
    await save(decision({ baseVersionNumber: 1, evidenceIds: [] }));
    const [v2, v1] = await decisionHistory(ctxA(), p.id, 'Q-PP-01');
    expect(v1.evidence.map((e) => e.id)).toEqual([file.id]);
    expect(v2.evidence).toEqual([]);
    expect((await readEvidenceForDownload(ctxA(), assessor(), file.id)).bytes).toEqual(PDF_BYTES);
  });

  it('FR-EVD-03 NFR-SEC-10: a link evidence target receives no request on save or view', async () => {
    const hits: string[] = [];
    const srv = http.createServer((q, r) => { hits.push(q.url ?? ''); r.end(); });
    await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
    try {
      const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/ethics.pdf`;
      const body = { kind: 'link', url, label: null };
      const link = (await createLinkEvidence(ctxA(), assessor(), { projectId: p.id, url, label: null, requestId: randomUUID() },
        requestDigest({ path: { id: p.id }, body }))).value;
      await save(decision({ baseVersionNumber: null, evidenceIds: [link.id] }));
      renderToStaticMarkup(createElement(VersionEvidenceList, { orgSlug: fx.org.slug, items: (await decisionHistory(ctxA(), p.id, 'Q-PP-01'))[0].evidence }));
      await new Promise((ok) => setTimeout(ok, 500));
      expect(hits).toEqual([]);
    } finally {
      srv.close();
    }
  });
});
