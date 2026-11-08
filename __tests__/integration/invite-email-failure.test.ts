import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { testDb, resetDb } from '../helpers/db';
import { stubAcceptanceRows } from '../helpers/legalStub';
import { sessionFor, clearSession } from '../helpers/authSession';

/**
 * D-188 / O-7 (Phase 1d-i Task 3). `POST .../orgs/[slug]/members` has caught
 * a failed email leg since Task 9 (app/api/v1/orgs/[slug]/members/route.ts:
 * 104-127) so a failed send never costs the inviter the `acceptUrl` that
 * already exists -- but until now nothing exercised that path at the HTTP
 * layer: `__tests__/integration/invitations.test.ts` drives `createInvitation`
 * (lib/data/members.ts) directly, which has no email leg at all, and the
 * e2e suite always ran against a real, working RESEND_API_KEY before this
 * task. This is the first test where the email leg is made to fail on
 * purpose, at the route, so a regression that lets the throw escape the
 * inner catch (-> 500, destroying the copy-link the invitation row already
 * created) is caught here instead of surfacing three files away as a
 * confusing e2e failure (D-188).
 *
 * Both env vars are stubbed explicitly rather than left to inherit `.env`:
 * a real `vitest run` does NOT auto-load `.env` (verified directly -- a
 * throwaway probe test read both `process.env.EMAIL_FROM_ADDRESS` and
 * `process.env.RESEND_API_KEY` as `undefined` inside a real vitest run;
 * only vitest.config.ts's own `test.env` block populates anything, and it
 * names neither key). So EMAIL_FROM_ADDRESS must be stubbed here or the
 * route's OTHER, upstream short-circuit (route.ts:105-108, checked BEFORE
 * `sendEmail` is ever reached) fires instead -- which would make this test
 * pass for the wrong reason and leave the actual target, the email-leg
 * catch, completely untested.
 */

async function invitePost(slug: string, body: unknown): Promise<Response> {
  const mod = await import('../../app/api/v1/orgs/[slug]/members/route');
  const req = new NextRequest('http://localhost/probe', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  return mod.POST(req, { params: Promise.resolve({ slug }) });
}

describe('POST .../members -- 201 with acceptUrl when the email leg fails (D-188, O-7)', () => {
  beforeEach(() => {
    clearSession();
    vi.stubEnv('EMAIL_FROM_ADDRESS', 'onboarding@resend.dev');
    vi.stubEnv('RESEND_API_KEY', '');
    return resetDb();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function seedOrgWithOwner(slug: string) {
    const owner = await testDb.user.create({
      data: { email: `${slug}-owner@fixture.test`, name: 'Owner', passwordHash: 'x' },
    });
    await testDb.consentRecord.createMany({ data: stubAcceptanceRows(owner.id) });
    const org = await testDb.organization.create({ data: { name: slug, slug } });
    await testDb.membership.create({ data: { orgId: org.id, userId: owner.id, role: 'owner' } });
    sessionFor(owner.id);
    return { owner, org };
  }

  it('returns 201 with a usable acceptUrl when the email leg fails', async () => {
    // PROPERTY: a failed email must never cost the inviter the copy-link.
    // WHAT THIS CAUSES: the route is called with no RESEND_API_KEY, so the
    // email leg throws; if that throw ever escapes the inner catch, the
    // shared handler returns 500 and this assertion fails. A regression to
    // 500 would otherwise surface only as a confusing e2e failure three
    // files away.
    const { org } = await seedOrgWithOwner('inv-fail-a');
    const requestId = randomUUID();
    const res = await invitePost(org.slug, { requestId, email: 'someone@example.test', role: 'assessor', showLink: true });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.acceptUrl).toMatch(/\/invitations\/[A-Za-z0-9_-]+$/);
    expect(body.emailSent).toBe(false);
    // the failed send did not undo the invitation, nor its receipt
    expect(await testDb.invitation.count({ where: { orgId: org.id, email: 'someone@example.test', status: 'pending' } })).toBe(1);
    expect(await testDb.requestReceipt.findMany({ where: { orgId: org.id } }))
      .toEqual([expect.objectContaining({ requestId, route: 'app/api/v1/orgs/[slug]/members/route.ts::POST' })]);
  });
});
