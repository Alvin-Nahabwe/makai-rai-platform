import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createHash } from 'node:crypto';
import { testDb, resetDb } from '../helpers/db';
import { captureLogs } from '../helpers/logCapture';
import { withTriggersDisabled } from '../helpers/triggers';
import { buildOrg, buildPlatformAdmin, ctxFor, type FixtureAccount, type OrgFixture } from '../helpers/recordFixture';
import { listOrganisationEvents } from '../../lib/data/orgEvents';
import { ALL_ORG_EVENT_ACTIONS, OrganisationEventsList, actionWords } from '../../components/org/OrganisationEventsList';
import type { OrgEventView } from '../../types/api';
import { ORG_COPY } from '../../lib/org/copy';
import { GONE_NAME_COPY } from '../../lib/http/copy';

/**
 * S-30's read and its slot (FR-ORG-09; SRS lines 333, 577): the organisation's own administrator and membership
 * rows, shown to owners and admins only.
 */

const hex = (s: string) => createHash('sha256').update(s).digest('hex');

let admin: FixtureAccount;
let fxA: OrgFixture;
let fxB: OrgFixture;

/**
 * The database stamps `at` in the organisation_events_db_time trigger (clock_timestamp, cut to the millisecond), so
 * a supplied `at` is dropped and two rows inserted in one millisecond tie. These cases order rows by the `at` they
 * give, so the trigger is switched off for the insert (and restored) and the supplied time stands.
 */
async function event(fx: OrgFixture, row: { actorId: string; actorRole: string; action: string; targetUserId?: string | null;
  targetInvitationId?: string | null; reason?: string | null; requestReference?: string | null; previousValue?: string | null; at: Date }) {
  let created!: Awaited<ReturnType<typeof testDb.organisationEvent.create>>;
  await withTriggersDisabled('organisation_events', async () => {
    created = await testDb.organisationEvent.create({ data: { orgId: fx.org.id, ...row } });
  }, ['organisation_events_db_time']);
  return created;
}

beforeEach(async () => {
  await resetDb();
  admin = await buildPlatformAdmin();
  fxA = await buildOrg({ label: 'a' });
  fxB = await buildOrg({ label: 'b' });
  const t0 = Date.now() - 3600_000;
  await event(fxA, { actorId: admin.userId, actorRole: 'platform_admin', action: 'organisation_created', at: new Date(t0) });
  await event(fxA, { actorId: admin.userId, actorRole: 'platform_admin', action: 'organisation_name_corrected', previousValue: 'Old Lab Name', at: new Date(t0 + 1000) });
  await event(fxA, { actorId: fxA.members.owner.userId, actorRole: 'owner', action: 'member_role_changed', targetUserId: fxA.members.viewer.userId, at: new Date(t0 + 2000) });
  await event(fxA, { actorId: admin.userId, actorRole: 'platform_admin', action: 'account_deactivated', targetUserId: fxA.members.owner.userId, requestReference: 'CTRL-7', at: new Date(t0 + 3000) });
  await event(fxB, { actorId: admin.userId, actorRole: 'platform_admin', action: 'organisation_created', at: new Date(t0) });
});

describe('listOrganisationEvents', () => {
  it('FR-ORG-09: S-30 of organisation A lists no row of B, and only owners and admins may read it', async () => {
    const a = await listOrganisationEvents(ctxFor(fxA, 'owner'), { limit: 100 });
    expect(a.events.length).toBe(4);
    const bIds = (await testDb.organisationEvent.findMany({ where: { orgId: fxB.org.id } })).map((e) => e.id);
    expect(bIds.length).toBeGreaterThan(0);
    expect(a.events.every((e) => !bIds.includes(e.id))).toBe(true);
    expect((await listOrganisationEvents(ctxFor(fxA, 'admin'), { limit: 100 })).events.length).toBe(4);
    for (const role of ['assessor', 'reviewer', 'viewer'] as const)
      await expect(listOrganisationEvents(ctxFor(fxA, role), { limit: 10 })).rejects.toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('FR-ORG-09: rows are newest first and name the actor, the target and the earlier value', async () => {
    const { events, hasMore } = await listOrganisationEvents(ctxFor(fxA, 'owner'), { limit: 100 });
    expect(hasMore).toBe(false);
    expect(events.map((e) => e.action)).toEqual(['account_deactivated', 'member_role_changed', 'organisation_name_corrected', 'organisation_created']);
    expect(events[0]).toMatchObject({ actorName: admin.name, actorRole: 'platform_admin', targetName: fxA.members.owner.name, requestReference: 'CTRL-7' });
    expect(events[1]).toMatchObject({ actorName: fxA.members.owner.name, actorRole: 'owner', targetName: fxA.members.viewer.name });
    expect(events[2]).toMatchObject({ previousValue: 'Old Lab Name', targetName: null });
    expect(Object.keys(events[0]).sort()).toEqual(['action', 'actorName', 'actorRole', 'at', 'id', 'previousValue', 'reason', 'requestReference', 'targetName']);
    expect(events[0].at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it('FR-ORG-09: an invitation target is named by the invited email', async () => {
    const inv = await testDb.invitation.create({ data: {
      orgId: fxA.org.id, email: 'head@fixture.test', role: 'owner', kind: 'first_owner', tokenHash: hex('t'),
      invitedById: admin.userId, expiresAt: new Date(Date.now() + 86_400_000),
    } });
    await event(fxA, { actorId: admin.userId, actorRole: 'platform_admin', action: 'owner_invitation_issued', targetInvitationId: inv.id, requestReference: 'CTRL-2', at: new Date() });
    const [first] = (await listOrganisationEvents(ctxFor(fxA, 'admin'), { limit: 1 })).events;
    expect(first).toMatchObject({ action: 'owner_invitation_issued', targetName: 'head@fixture.test', requestReference: 'CTRL-2' });
  });

  it('FR-ORG-09: a row whose account or invitation is gone is still listed, named as gone, and logged with its ids', async () => {
    const ghost = '00000000-0000-4000-8000-0000000000aa';
    const e = await event(fxA, { actorId: admin.userId, actorRole: 'platform_admin', action: 'account_deactivated', targetUserId: ghost, at: new Date() });
    const g = await event(fxA, { actorId: ghost, actorRole: 'platform_admin', action: 'owner_invitation_revoked', targetInvitationId: ghost, at: new Date(Date.now() + 1000) });
    const { result, lines } = await captureLogs(() => listOrganisationEvents(ctxFor(fxA, 'owner'), { limit: 2 }));
    expect(result.events.map((x) => x.id)).toEqual([g.id, e.id]);
    expect(result.events[0]).toMatchObject({ actorName: GONE_NAME_COPY.deletedAccount, targetName: GONE_NAME_COPY.removedInvitation });
    expect(result.events[1]).toMatchObject({ actorName: admin.name, targetName: GONE_NAME_COPY.deletedAccount });
    const logged = lines.filter((l) => l.includes('org_event_reference_missing'));
    expect(logged).toEqual([
      `org_event_reference_missing event=${g.id} field=actorId id=${ghost}`,
      `org_event_reference_missing event=${g.id} field=targetInvitationId id=${ghost}`,
      `org_event_reference_missing event=${e.id} field=targetUserId id=${ghost}`,
    ]);
    // At warn (ruling 4): the page still answers; the gap is a data condition, not a failure of the request.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await listOrganisationEvents(ctxFor(fxA, 'owner'), { limit: 2 });
      expect(warn.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('org_event_reference_missing'))).toHaveLength(3);
      expect(error.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('org_event_reference_missing'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  it('FR-ORG-09: events page back with before and hasMore', async () => {
    const p1 = await listOrganisationEvents(ctxFor(fxA, 'admin'), { limit: 2 });
    const p2 = await listOrganisationEvents(ctxFor(fxA, 'admin'), { before: p1.events.at(-1)!.id, limit: 2 });
    expect(p1.hasMore).toBe(true);
    expect(p2.events.map((e) => e.id)).not.toContain(p1.events[0].id);
    expect([...p1.events, ...p2.events].map((e) => e.action)).toEqual(['account_deactivated', 'member_role_changed', 'organisation_name_corrected', 'organisation_created']);
    expect(p2.hasMore).toBe(false);
  });

  it('FR-ORG-09: events with the same time page in id order, with no row twice and none missed across a before boundary', async () => {
    const same = new Date(Date.now() + 60_000);
    const tied = [];
    for (let i = 0; i < 3; i++)
      tied.push(await event(fxA, { actorId: admin.userId, actorRole: 'platform_admin', action: 'account_deactivated', targetUserId: fxA.members.viewer.userId, requestReference: `TIE-${i}`, at: same }));
    expect(new Set((await testDb.organisationEvent.findMany({ where: { id: { in: tied.map((e) => e.id) } } })).map((e) => e.at.getTime()))).toEqual(new Set([same.getTime()]));
    const tiedByIdDesc = tied.map((e) => e.id).sort().reverse();
    const rest = (await listOrganisationEvents(ctxFor(fxA, 'owner'), { limit: 100 })).events.slice(3).map((e) => e.id);
    expect(rest).toHaveLength(4);
    // One row per page, so every boundary falls between rows of one time, then again where the time changes.
    const seen: string[] = [];
    let before: string | undefined;
    for (let i = 0; i < 7; i++) {
      const pg = await listOrganisationEvents(ctxFor(fxA, 'owner'), { before, limit: 1 });
      expect(pg.events).toHaveLength(1);
      expect(pg.hasMore).toBe(i < 6);
      seen.push(pg.events[0].id);
      before = pg.events[0].id;
    }
    expect(seen.slice(0, 3)).toEqual(tiedByIdDesc);
    expect(seen.slice(3)).toEqual(rest);
    expect(new Set(seen).size).toBe(7);
    // The same through pages of two.
    const p1 = await listOrganisationEvents(ctxFor(fxA, 'owner'), { limit: 2 });
    const p2 = await listOrganisationEvents(ctxFor(fxA, 'owner'), { before: p1.events.at(-1)!.id, limit: 2 });
    expect([...p1.events, ...p2.events].map((e) => e.id)).toEqual(seen.slice(0, 4));
  });

  it('FR-ORG-09: a page size outside 1 to 100, or a before that is not an event of this organisation, is refused', async () => {
    for (const limit of [0, 101, 1.5])
      await expect(listOrganisationEvents(ctxFor(fxA, 'owner'), { limit })).rejects.toMatchObject({ status: 422, code: 'validation' });
    const bEvent = await testDb.organisationEvent.findFirstOrThrow({ where: { orgId: fxB.org.id } });
    await expect(listOrganisationEvents(ctxFor(fxA, 'owner'), { before: bEvent.id, limit: 10 })).rejects.toMatchObject({ status: 422, code: 'validation' });
  });
});

describe('the S-30 action rows', () => {
  it('FR-ORG-09 NFR-A11Y-05: every action has words, and the administrator is named by role', async () => {
    const constraint = await testDb.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
      WHERE c.conrelid = 'organisation_events'::regclass AND c.contype = 'c' AND pg_get_constraintdef(c.oid) LIKE '%action%'`;
    const allowed = [...constraint.map((r) => r.def).join(' ').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1]);
    expect([...ALL_ORG_EVENT_ACTIONS].sort()).toEqual([...new Set(allowed)].sort());   // the database's list, read from another root
    for (const action of ALL_ORG_EVENT_ACTIONS) expect(actionWords(action)).not.toMatch(/_|[–—‘’“”]/);
    const adminEvent: OrgEventView = { id: 'e1', actorName: 'Ada Admin', actorRole: 'platform_admin', action: 'organisation_name_corrected',
      targetName: null, reason: null, requestReference: 'CTRL-9', previousValue: 'Old Name', at: '2026-11-02T07:42:00.000Z' };
    const html = renderToString(createElement(OrganisationEventsList, { events: [adminEvent], hasMore: false }));
    expect(html).toContain('MAK-AI administrator');
    expect(html).toContain('<caption');
    for (const text of [ORG_COPY.events.actions.organisation_name_corrected, 'CTRL-9', 'Old Name', '2 Nov 2026']) expect(html).toContain(text);
    expect(html).not.toContain('platform_admin');
    // A member's role at the time is the vocabulary's word (OR79), never the raw value.
    const ownerEvent: OrgEventView = { ...adminEvent, id: 'e2', actorName: 'Olu Owner', actorRole: 'owner', action: 'member_invited', requestReference: null, previousValue: null };
    const owned = renderToString(createElement(OrganisationEventsList, { events: [ownerEvent], hasMore: false }));
    expect(owned).toContain('Olu Owner (Owner)');
    expect(owned).not.toContain('(owner)');
    expect(html).not.toContain('Show older');
    expect(renderToString(createElement(OrganisationEventsList, { events: [adminEvent], hasMore: true }))).toContain('Show older');
  });

  it('FR-ORG-09 (answer Q23): the six column headings, the fifth naming both things its cell may hold', () => {
    const event: OrgEventView = { id: 'e3', actorName: 'Ada Admin', actorRole: 'platform_admin', action: 'owner_invitation_issued',
      targetName: null, reason: null, requestReference: 'CTRL-23', previousValue: null, at: '2026-11-02T07:42:00.000Z' };
    const html = renderToString(createElement(OrganisationEventsList, { events: [event], hasMore: false }));
    const headings = [...html.matchAll(/<th[^>]*scope="col"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]);
    expect(headings).toEqual(['When', 'Who', 'What', 'Member or invitation', 'Reason or request reference', 'Before the change']);
    expect(headings[4]).toBe(ORG_COPY.events.columns.reason);
  });
});
