import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InviteMemberResponse } from '@/types/api';
import { resetDb, testDb } from '../helpers/db';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { markerFor } from '../helpers/markers';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { callRoute, sessionAs, type Method } from '../helpers/routeDriver';

/** MEM Task 6: what member actions write to the log (NFR-OBS-01, NFR-PRIV-03; obligation M6). */
const sendEmailMock = vi.hoisted(() => vi.fn(async (_m: { to: string }) => ({ id: 'msg_1' })));
vi.mock('@/lib/email/send', () => ({ sendEmail: sendEmailMock }));

const MEMBERS = 'app/api/v1/orgs/[slug]/members/route.ts';
const MEMBER = 'app/api/v1/orgs/[slug]/members/[userId]/route.ts';
const LEAVE = 'app/api/v1/orgs/[slug]/members/leave/route.ts';
const RESEND = 'app/api/v1/orgs/[slug]/invitations/[invitationId]/resend/route.ts';
const REVOKE = 'app/api/v1/orgs/[slug]/invitations/[invitationId]/revoke/route.ts';
let fx: OrgFixture;

const call = (method: Method, file: string, body: Record<string, unknown>, params?: Record<string, string>) =>
  callRoute(file, method, { slug: fx.org.slug, params, body: { requestId: randomUUID(), ...body } });

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'onboarding@resend.dev');
  vi.stubEnv('RESEND_API_KEY', 'fixture-key-not-real');   // sendEmail is mocked: this only satisfies the service's check
  fx = await buildOrg();
  // Member names carry markers, so a name in any log line is found.
  let n = 0;
  for (const m of Object.values(fx.members)) await testDb.user.update({ where: { id: m.userId }, data: { name: markerFor('name', ++n) } });
  sessionAs(fx.members.owner.userId);
});

describe('member action logs', () => {
  it('NFR-OBS-01 NFR-PRIV-03: member actions log ids only', async () => {
    const { lines } = await captureLogs(async () => {
      const invited: InviteMemberResponse[] = [];
      for (const [i, showLink] of [[1, true], [2, false]] as const) {
        const r = await call('POST', MEMBERS, { email: `${markerFor('email', i).toLowerCase()}@fixture.test`, role: 'viewer', showLink });
        invited.push((await r.json()) as InviteMemberResponse);
      }
      sendEmailMock.mockRejectedValueOnce(new Error('smtp down'));
      await call('POST', MEMBERS, { email: 'failing@fixture.test', role: 'viewer', showLink: true });
      await call('POST', RESEND, { showLink: true }, { invitationId: invited[0].invitation.id });
      await call('POST', REVOKE, {}, { invitationId: invited[1].invitation.id });
      await call('PATCH', MEMBER, { role: 'reviewer' }, { userId: fx.members.assessor.userId });
      await call('DELETE', MEMBER, {}, { userId: fx.members.reviewer.userId });
      sessionAs(fx.members.viewer.userId);
      await call('POST', LEAVE, {});
      sessionAs(fx.members.owner.userId);
      // the 21st invitation of the hour (the owner has made 3 invitations and a resend): rows written directly fill the rest
      await testDb.invitation.createMany({ data: Array.from({ length: 16 }, (_, i) => ({
        orgId: fx.org.id, email: `fill-${i}@fixture.test`, role: 'viewer' as const, invitedById: fx.members.owner.userId,
        tokenHash: `${i}`.padStart(64, 'a'), expiresAt: new Date(Date.now() + 86_400_000),
      })) });
      await call('POST', MEMBERS, { email: 'limit@fixture.test', role: 'viewer', showLink: false });
    });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    expect(lines.filter((l) => l.includes('ORG_MEMBER_ACTION')).length).toBeGreaterThanOrEqual(6);
    expect(lines.some((l) => l.includes('RATE_LIMIT_EXCEEDED'))).toBe(true);
    for (const l of lines) expect(l).not.toMatch(/\/invitations\/[0-9a-f]{64}|[0-9a-f]{64}/);
  });

  it('NFR-OBS-01 NFR-PRIV-03 (M6): a failed send logs a fixed code, never the provider\'s text, even when that text holds an address', async () => {
    const leaked = `${markerFor('email', 9).toLowerCase()}@fixture.test`;
    sendEmailMock.mockRejectedValueOnce(new Error(`You can only send testing emails to ${leaked}`));
    const { lines } = await captureLogs(async () => { await call('POST', MEMBERS, { email: 'failing2@fixture.test', role: 'viewer', showLink: true }); });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    expect(lines.filter((l) => l.includes('invite_email_failed') && l.includes('send_failed'))).toHaveLength(1);
  });
});
