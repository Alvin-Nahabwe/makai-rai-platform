import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import type { OrgRole } from '@prisma/client';
import { testDb, resetDb } from '../helpers/db';
import { buildOrg, type OrgFixture } from '../helpers/recordFixture';
import { captureLogs, scanLines } from '../helpers/logCapture';
import { STUB_LEGAL_TEXTS, currentAcceptances } from '../helpers/legalStub';
import { hashInvitationToken } from '../../lib/data/invitationToken';
import { ACCEPTED_KINDS } from '../../types/legal';

/**
 * Route 31, POST /api/v1/invitations/[token]/register (FR-ACC-01, FR-ACC-03, FR-ACC-10; contract
 * Routes row 31): an account is created only from a pending, unexpired invitation, with all three
 * acceptances, and its user row, acceptance rows and membership commit together or not at all.
 * Under vitest the registry is the stub of __tests__/setup/legal.ts.
 */

vi.mock('@/lib/email/send', () => ({ sendEmail: vi.fn(async () => ({ id: 'email-test-id' })) }));
vi.mock('@/lib/data/preauth', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/data/preauth')>();
  return { ...real, invitationByToken: vi.fn(real.invitationByToken), membershipsForUser: vi.fn(real.membershipsForUser) };
});
vi.mock('bcryptjs', async (importOriginal) => {
  const real = await importOriginal<typeof import('bcryptjs')>();
  return { ...real, hash: vi.fn(real.hash) };
});

const { POST } = await import('@/app/api/v1/invitations/[token]/register/route');
const { sendEmail } = await import('@/lib/email/send');
const { invitationByToken, membershipsForUser } = await import('@/lib/data/preauth');
const realPreauth = await vi.importActual<typeof import('@/lib/data/preauth')>('@/lib/data/preauth');
const bcrypt = await import('bcryptjs');
const { validatePassword, PASSWORD_MIN_LENGTH } = await import('@/lib/validate');

const M23 = 'This invitation link does not work. It may have expired, been used, or been replaced by a newer one. Ask the person who invited you to send it again.';
const bodyA = { name: 'New Person', password: 'a'.repeat(12), acceptances: currentAcceptances() };

let fx: OrgFixture;

async function invitationRow(org: OrgFixture, a: { email: string; role: OrgRole; linkShownAt?: Date | null;
  status?: 'pending' | 'accepted' | 'revoked' | 'expired'; expiresAt?: Date }) {
  const raw = randomBytes(32).toString('hex');
  const inv = await testDb.invitation.create({ data: {
    orgId: org.org.id, email: a.email, role: a.role, tokenHash: hashInvitationToken(raw), invitedById: org.members.owner.userId,
    expiresAt: a.expiresAt ?? new Date(Date.now() + 7 * 24 * 3600 * 1000), status: a.status ?? 'pending', linkShownAt: a.linkShownAt ?? null,
  } });
  return { raw, inv };
}

function register(token: string, body: unknown, headers: Record<string, string> = {}) {
  return POST(new NextRequest(`http://localhost/api/v1/invitations/${token}/register`, {
    method: 'POST', headers: { 'content-type': 'application/json', host: 'localhost', ...headers }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ token }) });
}

async function counts(email: string) {
  const user = await testDb.user.findUnique({ where: { email } });
  if (user === null) return { users: 0, memberships: 0, consent_records: 0 };
  return { users: 1, memberships: await testDb.membership.count({ where: { userId: user.id } }),
    consent_records: await testDb.consentRecord.count({ where: { userId: user.id } }) };
}
async function memberRole(email: string, orgId: string) {
  const user = await testDb.user.findUniqueOrThrow({ where: { email } });
  return (await testDb.membership.findFirstOrThrow({ where: { userId: user.id, orgId } })).role;
}
async function rowsOf(email: string) {
  const user = await testDb.user.findUniqueOrThrow({ where: { email } });
  return testDb.consentRecord.findMany({ where: { userId: user.id }, orderBy: { consentType: 'asc' } });
}

beforeEach(async () => {
  await resetDb();
  vi.stubEnv('EMAIL_FROM_ADDRESS', 'MAK-AI <noreply@fixture.test>');
  vi.mocked(sendEmail).mockClear();
  vi.mocked(bcrypt.hash).mockClear();
  fx = await buildOrg();
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe('route 31: an account only from an invitation, with its acceptances (FR-ACC-01, FR-ACC-03)', () => {
  it('FR-ACC-03: one box unticked: 422 naming it, and no user, membership or acceptance row', async () => {
    const { raw } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    const res = await register(raw, { name: 'New', password: 'a'.repeat(12), acceptances: currentAcceptances(['terms', 'privacy']) });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: 'validation', missing: ['cross-border-consent'],
      error: 'To continue, accept the cross-border storage consent.',
      fields: [{ field: 'acceptances.cross-border-consent', message: 'To continue, accept the cross-border storage consent.' }] });
    expect(await counts('new@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
  });

  it('FR-ACC-03 FR-ACC-01: all three ticked: three rows with current versions and hashes, one membership with the invitation role', async () => {
    const { raw, inv } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    const res = await register(raw, { name: 'New', password: 'a'.repeat(12), acceptances: currentAcceptances() });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ orgSlug: fx.org.slug });
    expect(await counts('new@fixture.test')).toEqual({ users: 1, memberships: 1, consent_records: 3 });
    expect(await memberRole('new@fixture.test', fx.org.id)).toBe('assessor');
    expect((await rowsOf('new@fixture.test')).map((r) => [r.consentType, r.version, r.textHash, r.granted])).toEqual([
      ['terms_of_service', '1', STUB_LEGAL_TEXTS[0].sha256, true], ['privacy_policy', '1', STUB_LEGAL_TEXTS[1].sha256, true],
      ['cross_border_storage', '1', STUB_LEGAL_TEXTS[2].sha256, true]]);
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('accepted');
  });

  it('FR-ACC-01 FR-ACC-03: a posted email, role and version are ignored', async () => {
    const { raw } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    const res = await register(raw, { name: 'N', password: 'a'.repeat(12), acceptances: currentAcceptances(), email: 'x@evil.test', role: 'owner', version: '0' });
    expect(res.status).toBe(201);
    expect(await counts('x@evil.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
    expect(await memberRole('new@fixture.test', fx.org.id)).toBe('assessor');
    expect((await rowsOf('new@fixture.test')).map((r) => r.version)).toEqual(['1', '1', '1']);
  });

  it('FR-ACC-03: an acceptance list holding anything but the three kinds is refused and nothing is created', async () => {
    const { raw } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    for (const acceptances of [[...currentAcceptances(), { kind: 'organisation-agreement', version: '1' }], 'terms', [...currentAcceptances(), 7],
      null, [...ACCEPTED_KINDS], [{ kind: 'terms' }, ...currentAcceptances(['privacy', 'cross-border-consent'])]]) {
      const res = await register(raw, { ...bodyA, acceptances });
      expect([res.status, (await res.json()).code], JSON.stringify(acceptances)).toEqual([422, 'validation']);
    }
    expect(await counts('new@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
  });

  it('FR-ACC-03 (threat A5): a version that is not the current one answers 409 with M-39 and nothing is created', async () => {
    const { raw, inv } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    const res = await register(raw, { ...bodyA, acceptances: [...currentAcceptances(['terms', 'privacy']), { kind: 'cross-border-consent', version: '0' }] });
    expect([res.status, await res.json()]).toEqual([409, {
      error: 'A new version of the cross-border storage consent was published on 30 Oct 2026.', code: 'legal_text_changed',
      missing: ['cross-border-consent'] }]);
    expect(await counts('new@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
  });

  it('FR-ACC-01 (7.4.2 S-04 validation): an empty name or a short password answers 422 naming the field, and nothing is created', async () => {
    const { raw } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    const res = await register(raw, { name: '', password: 'short', acceptances: currentAcceptances() });
    expect(res.status).toBe(422);
    expect((await res.json()).fields.map((f: { field: string }) => f.field)).toEqual(['name', 'password']);
    expect(await counts('new@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
  });

  it('FR-ACC-01 (7.4.2 S-04 "Name required"): a name of spaces only answers 422 naming the name, and nothing is created', async () => {
    const { raw } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    const before = { users: await testDb.user.count(), memberships: await testDb.membership.count(), consent_records: await testDb.consentRecord.count() };
    const res = await register(raw, { ...bodyA, name: '   ' });
    expect(res.status).toBe(422);
    expect((await res.json()).fields).toEqual([{ field: 'name', message: 'Name is required' }]);
    expect({ users: await testDb.user.count(), memberships: await testDb.membership.count(), consent_records: await testDb.consentRecord.count() })
      .toEqual(before);
  });

  it('FR-ACC-01 NFR-AVL-04: the slug comes from the invitation read, so a failed membership read after the commit still answers 201', async () => {
    const { raw } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    vi.mocked(membershipsForUser).mockRejectedValue(new Error('simulated: the membership read fails'));
    try {
      const res = await register(raw, bodyA);
      expect([res.status, await res.json()]).toEqual([201, { orgSlug: fx.org.slug }]);
    } finally {
      vi.mocked(membershipsForUser).mockImplementation(realPreauth.membershipsForUser);
    }
    expect(await counts('new@fixture.test')).toEqual({ users: 1, memberships: 1, consent_records: 3 });
  });

  it('FR-ACC-01 (gap G027): an existing account with the invitation\'s email answers 409 account_exists and the invitation stays usable', async () => {
    const { raw, inv } = await invitationRow(fx, { email: fx.members.viewer.email, role: 'assessor' });
    const res = await register(raw, bodyA);
    expect([res.status, await res.json()]).toEqual([409, { error: 'An account with this email already exists. Sign in to accept.', code: 'account_exists' }]);
    expect((await testDb.invitation.findUniqueOrThrow({ where: { id: inv.id } })).status).toBe('pending');
  });

  it('FR-ACC-03 NFR-SEC-05: two concurrent registrations on one token leave one user, three rows and one membership', async () => {
    const { raw } = await invitationRow(fx, { email: 'new@fixture.test', role: 'assessor' });
    const [a, b] = await Promise.all([register(raw, bodyA), register(raw, bodyA)]);
    expect([a.status, b.status].filter((s) => s === 201)).toHaveLength(1);
    expect([409, 410]).toContain([a.status, b.status].find((s) => s !== 201));   // users.email unique, or the token already used
    expect(await counts('new@fixture.test')).toEqual({ users: 1, memberships: 1, consent_records: 3 });
  });

  it('FR-ACC-01 NFR-SEC-05: used, expired, revoked, resent-over and unknown tokens get one identical 410', async () => {
    const used = (await invitationRow(fx, { email: 'u1@fixture.test', role: 'viewer', status: 'accepted' })).raw;
    const expired = (await invitationRow(fx, { email: 'u2@fixture.test', role: 'viewer', expiresAt: new Date(Date.now() - 1000) })).raw;
    const revoked = (await invitationRow(fx, { email: 'u3@fixture.test', role: 'viewer', status: 'revoked' })).raw;
    // A resend makes a new row and marks the old one revoked (adminResendInvitation, FR-MEM-02): the old link is unusable.
    const resentOver = (await invitationRow(fx, { email: 'u4@fixture.test', role: 'viewer', status: 'revoked' })).raw;
    await invitationRow(fx, { email: 'u4@fixture.test', role: 'viewer' });
    const bodies = await Promise.all([used, expired, revoked, resentOver, 'f'.repeat(64)].map(async (t) => {
      const r = await register(t, bodyA); return [r.status, await r.text()]; }));
    expect(new Set(bodies.map((x) => JSON.stringify(x))).size).toBe(1);
    expect(bodies[0]).toEqual([410, JSON.stringify({ error: M23, code: 'invitation_unusable' })]);
    for (const e of ['u1', 'u2', 'u3', 'u4']) expect(await counts(`${e}@fixture.test`)).toEqual({ users: 0, memberships: 0, consent_records: 0 });
  });

  it('FR-ACC-01: an unknown token answers 410 before any password hash', async () => {
    const res = await register('f'.repeat(64), bodyA);
    expect(res.status).toBe(410);
    expect(vi.mocked(bcrypt.hash)).not.toHaveBeenCalled();
  });

  it('FR-ACC-10: one E-06 to the invited address on creation, with or without linkShownAt', async () => {
    for (const shown of [null, new Date()]) {
      const email = `n${shown ? 1 : 0}@fixture.test`;
      const { raw } = await invitationRow(fx, { email, role: 'viewer', linkShownAt: shown });
      expect((await register(raw, bodyA)).status).toBe(201);
      expect(sendEmail).toHaveBeenLastCalledWith(expect.objectContaining({ to: email, from: 'MAK-AI <noreply@fixture.test>',
        subject: 'An account was created for this address' }));
      expect(vi.mocked(sendEmail).mock.lastCall![0].text).toContain(`in ${fx.org.name} on `);
    }
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('FR-ACC-10: a failed E-06 send leaves the account created and logs no email', async () => {
    const { raw } = await invitationRow(fx, { email: 'fail@fixture.test', role: 'viewer' });
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('Email send failed (validation_error): x'));
    const { result, lines } = await captureLogs(() => register(raw, bodyA));
    expect(result.status).toBe(201);
    expect(await counts('fail@fixture.test')).toEqual({ users: 1, memberships: 1, consent_records: 3 });
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    const user = await testDb.user.findUniqueOrThrow({ where: { email: 'fail@fixture.test' } });
    expect(lines.filter((l) => l.includes('AUTH_REGISTER'))).toEqual([expect.stringContaining(`"userId":"${user.id}"`)]);
    expect(lines.find((l) => l.includes('AUTH_REGISTER'))).toContain('"noticeSent":false');
  });

  it('NFR-OBS-01 FR-ACC-01: registration logs ids only', async () => {
    const { raw } = await invitationRow(fx, { email: 'logs@fixture.test', role: 'viewer' });
    const { result, lines } = await captureLogs(() => register(raw, { ...bodyA, name: 'Log Person' }));
    expect(result.status).toBe(201);
    expect(scanLines(lines, { markers: true, emails: true })).toEqual([]);
    const joined = lines.join('\n');
    for (const secret of ['Log Person', raw, 'logs@fixture.test', bodyA.password]) expect(joined).not.toContain(secret);
    expect(lines.filter((l) => l.includes('AUTH_REGISTER'))).toHaveLength(1);
  });

  it('FR-ACC-01 FR-ACC-03: a refusal by the database function inside the transaction answers the same 410 M-23 and leaves no user or row', async () => {
    // The invitation is revoked after route 31 read it and before its transaction: accept_invitation refuses it.
    const { raw, inv } = await invitationRow(fx, { email: 'race@fixture.test', role: 'viewer' });
    const stale = await invitationByToken(raw);
    await testDb.invitation.update({ where: { id: inv.id }, data: { status: 'revoked' } });
    vi.mocked(invitationByToken).mockResolvedValueOnce(stale);
    const res = await register(raw, bodyA);
    expect([res.status, await res.text()]).toEqual([410, JSON.stringify({ error: M23, code: 'invitation_unusable' })]);
    expect(await counts('race@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('FR-ACC-01: an invitation into an archived organisation is unusable: 410 M-23 and nothing is created', async () => {
    const { raw } = await invitationRow(fx, { email: 'archived@fixture.test', role: 'viewer' });
    await testDb.organization.update({ where: { id: fx.org.id }, data: { deletedAt: new Date() } });
    const res = await register(raw, bodyA);
    expect([res.status, await res.text()]).toEqual([410, JSON.stringify({ error: M23, code: 'invitation_unusable' })]);
    expect(await counts('archived@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
  });

  it('FR-ACC-10 NFR-OBS-01: an E-06 that cannot be sent logs why with a fixed code, ids only, and the account stands', async () => {
    const { raw } = await invitationRow(fx, { email: 'nosender@fixture.test', role: 'viewer' });
    vi.stubEnv('EMAIL_FROM_ADDRESS', '');
    const { result, lines } = await captureLogs(() => register(raw, bodyA));
    expect(result.status).toBe(201);
    expect(sendEmail).not.toHaveBeenCalled();
    const line = lines.find((l) => l.includes('AUTH_REGISTER'));
    expect(line).toContain('"noticeSent":false');
    expect(line).toContain('"reason":"sender_unset"');
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error('Email send failed (validation_error): nobody@fixture.test'));
    vi.stubEnv('EMAIL_FROM_ADDRESS', 'MAK-AI <noreply@fixture.test>');
    const second = await invitationRow(fx, { email: 'refused@fixture.test', role: 'viewer' });
    const { lines: lines2 } = await captureLogs(() => register(second.raw, bodyA));
    expect(lines2.find((l) => l.includes('AUTH_REGISTER'))).toContain('"reason":"send_failed"');
    expect(scanLines(lines2, { markers: true, emails: true })).toEqual([]);
  });

  it('NFR-SEC-08: cross-origin POST answers 403 cross_origin and writes nothing', async () => {
    const { raw } = await invitationRow(fx, { email: 'xo@fixture.test', role: 'viewer' });
    const res = await register(raw, bodyA, { origin: 'https://evil.example' });
    expect([res.status, (await res.json()).code]).toEqual([403, 'cross_origin']);
    expect(await counts('xo@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
  });

  it('FR-ACC-03: a registration sent with a client address stores none', async () => {
    const { raw } = await invitationRow(fx, { email: 'ip@fixture.test', role: 'viewer' });
    await register(raw, bodyA, { 'x-forwarded-for': '203.0.113.9', 'x-real-ip': '203.0.113.9' });
    expect((await rowsOf('ip@fixture.test')).map((r) => r.ipAddress)).toEqual([null, null, null]);
  });

  it('NFR-A11Y-04 (helper): the minimum length the form shows is the validator\'s', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))).not.toBeNull();
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(validatePassword('a'.repeat(PASSWORD_MIN_LENGTH - 1))?.message).toBe(`Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  });

  it('NFR-AVL-04 NFR-OBS-05: with the database unreachable, route 31 answers 503 database_unavailable with a reference and writes one REQUEST_FAILED line', async () => {
    // A network code is an outage to isDatabaseUnavailable (lib/data/pgErrors.ts); invitationByToken is the
    // handler's first database access and sits inside its try, so the answer is toResponse's.
    const { raw } = await invitationRow(fx, { email: 'outage@fixture.test', role: 'viewer' });
    vi.mocked(invitationByToken).mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    const { result, lines } = await captureLogs(() => register(raw, { name: 'Out Age', password: 'a'.repeat(12), acceptances: currentAcceptances() }));
    const body = await result.json();
    expect([result.status, body]).toEqual([503, { error: 'Service unavailable', code: 'database_unavailable', reference: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
    expect(lines.filter((l) => l.includes('REQUEST_FAILED') && l.includes(body.reference))).toHaveLength(1);
    expect(lines.join('\n')).not.toContain('Internal server error');
    expect(await counts('outage@fixture.test')).toEqual({ users: 0, memberships: 0, consent_records: 0 });
  });
});
