import { randomUUID as uuid } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerText } from '../helpers/markers';
import { callRoute, sessionAs } from '../helpers/routeDriver';
import { addDecision, addProject, addStageReview, buildOrg, type OrgFixture } from '../helpers/recordFixture';

/** FR-REV-07 and NFR-OBS-01: the content of the one SEAL_CREATED line a seal writes (REV-a writes it; this proves what it holds). */

const ROUTE = 'app/api/v1/orgs/[slug]/projects/[id]/reviews/[reviewId]/seals/route.ts';
let fx: OrgFixture;
let p: { id: string };
let r: { id: string };

beforeEach(async () => {
  await resetDb();
  const { contentVersionId } = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg({ text: markerText });
  p = await addProject(fx);
  await addDecision(fx, p.id, { stage: 'pre-processing', questionId: 'Q-PP-01', contentVersionId, declaredDate: '2026-10-20' });
  r = await addStageReview(fx, p.id, { stage: 'pre-processing', preparedFor: markerText('preparedFor', 1) });
});

describe('the seal log line', () => {
  it('FR-REV-07 NFR-OBS-01: a seal writes one SEAL_CREATED line with the fingerprint and no other field from the record', async () => {
    sessionAs(fx.members.reviewer.userId);
    const { result, lines } = await captureLogs(async () => {
      const res = await callRoute(ROUTE, 'POST', { slug: fx.org.slug, params: { id: p.id, reviewId: r.id }, body: { requestId: uuid() } });
      return { status: res.status, json: await res.json() };
    });
    expect(result.status).toBe(201);
    const ev = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }).filter((e) => e.event === 'SEAL_CREATED');
    expect(ev).toHaveLength(1);
    expect(ev[0].details).toEqual({ sealId: result.json.id, fingerprint: result.json.fingerprint, sealNumber: 1, sealedAt: result.json.sealedAt });
    expect(JSON.stringify(ev[0])).not.toContain(fx.org.name);
    expect(JSON.stringify(ev[0])).not.toContain(fx.org.slug);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
  });

  it('FR-REV-07: a replay of the same seal request writes no second line', async () => {
    sessionAs(fx.members.reviewer.userId);
    const body = { requestId: uuid() };
    await callRoute(ROUTE, 'POST', { slug: fx.org.slug, params: { id: p.id, reviewId: r.id }, body });
    const { lines } = await captureLogs(() => callRoute(ROUTE, 'POST', { slug: fx.org.slug, params: { id: p.id, reviewId: r.id }, body }));
    expect(lines.filter((l) => l.includes('SEAL_CREATED'))).toEqual([]);
  });
});
