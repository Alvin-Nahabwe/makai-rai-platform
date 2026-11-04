import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import MembersManager from '@/app/(authenticated)/orgs/[slug]/settings/members/MembersManager';
import type { InvitationView, MemberView } from '@/types/api';

/**
 * MEM Task 1 (and Task 7's S-22 cases below). vitest's environment is `node` and no DOM library is installed
 * (G-23; R12-15), so this file reads react-dom/server markup. Every case that presses, types or moves focus is a
 * Playwright case in e2e/members.spec.ts.
 */
const text = (html: string) => html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
const attrsOf = (raw: string) => Object.fromEntries([...raw.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? '']));
const tagsOf = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => attrsOf(m[1]));
const buttonsOf = (html: string) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({ attrs: attrsOf(m[1]), name: attrsOf(m[1])['aria-label'] ?? text(m[2]) }));

describe('CopyLinkFallback', () => {
  it('UX-23 FR-MEM-01: after an invitation with Show link, the link, the Copy button and the expiry sentence show', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl="https://h/invitations/t" expiresAt="2026-11-04T09:00:00.000Z" emailSent />);
    const [box] = tagsOf(html, 'input');
    expect(box).toMatchObject({ type: 'text', readonly: '', value: 'https://h/invitations/t' });
    expect(html).toMatch(new RegExp(`<label[^>]*for="${box.id}"[^>]*>[^<]*invitation link`, 'i'));
    const copy = buttonsOf(html).find((b) => b.name === 'Copy link')!;
    expect(copy.attrs).toMatchObject({ type: 'button' });
    expect(copy.attrs).not.toHaveProperty('disabled');
    expect(text(html)).toContain('The link works once and expires on 4 Nov 2026.');
  });
  it('UX-23 NFR-A11Y-05: the box mounts with an empty status region (a region inserted with text is not announced), and the failure sentence is plain text', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl="https://h/invitations/t" expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} />);
    expect(html).toMatch(/<div role="status"><\/div>/);
    expect(html).toMatch(/<p>The invitation email could not be sent\. Send this link another way\.<\/p>/);
  });
  it('UX-23: when the page announces the failure sentence itself, the box does not repeat it', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl="https://h/invitations/t" expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} noticeShownElsewhere />);
    expect(html).not.toContain('could not be sent');
    expect(html).toMatch(/<div role="status"><\/div>/);
  });
  it('UX-23: no link shown and the email failed: the Resend and show link button is rendered', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl={null} expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} onResendWithLink={() => {}} />);
    expect(buttonsOf(html).map((b) => b.name)).toContain('Resend and show link');
    expect(buttonsOf(html).map((b) => b.name)).not.toContain('Copy link');
  });
});

// ── S-22 (Task 7) ──────────────────────────────────────────────────────────────────────────────────────────────────
const m = (userId: string, name: string, role: MemberView['role'], createdFromShownLink = false): MemberView =>
  ({ userId, name, role, joinedAt: '2026-10-01T00:00:00.000Z', createdFromShownLink });
const m1 = m('u-owner', 'Nakato Sarah', 'owner');
const m2 = m('u-viewer', 'Okello James', 'viewer');
const pending: InvitationView = {
  id: 'i-1', email: 'pending@fixture.test', role: 'reviewer', kind: 'member', state: 'pending',
  expiresAt: '2026-11-04T09:00:00.000Z', createdAt: '2026-10-28T09:00:00.000Z', linkShown: false,
};
const common = { slug: 'acme', members: [m1, m2], invitations: [pending] };
const ownerProps = { ...common, currentUserId: m1.userId, currentRole: 'owner' as const };
const adminProps = { ...common, currentUserId: 'u-admin', currentRole: 'admin' as const };
const viewerProps = { ...common, currentUserId: m2.userId, currentRole: 'viewer' as const, invitations: [] };

describe('S-22 MembersManager', () => {
  it('UX-29 FR-MEM-04 FR-MEM-02: each member row and invitation row has an action button that names its object, and no dialog or open confirmation is rendered', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} />);
    const names = buttonsOf(html).map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining([`Remove ${m2.name}`, `Revoke invitation for ${pending.email}`]));
    expect(names).not.toContain('Remove member');
    expect(names).not.toContain('Revoke invitation');
    expect(html).not.toMatch(/role="dialog"|<dialog/);
  });

  it('FR-MEM-02: a viewer sees no pending invitations and no invite control, and can leave', () => {
    const html = renderToStaticMarkup(<MembersManager {...viewerProps} />);
    expect(html).not.toContain('Pending invitations');
    expect(buttonsOf(html).filter((b) => /Invite/.test(b.name))).toEqual([]);
    const leave = buttonsOf(html).find((b) => b.name === 'Leave this organisation')!;
    expect(leave).toBeDefined();
    expect(leave.attrs).not.toHaveProperty('disabled');
  });

  it("FR-MEM-01 FR-MEM-03: an admin's role list has no owner option", () => {
    const html = renderToStaticMarkup(<MembersManager {...adminProps} />);
    const id = /<label[^>]*for="([^"]+)"[^>]*>Role</.exec(html)?.[1];
    const options = [...(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '').matchAll(/<option\b[^>]*>([^<]*)<\/option>/g)].map((x) => x[1]);
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toContain('owner');
  });

  it('FR-MEM-02 (7.4.2 S-22): with no invitation the table, named by its caption, says "No pending invitations."', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} invitations={[]} />);
    expect(html).toMatch(/<table[^>]*>\s*<caption[^>]*>Pending invitations<\/caption>[\s\S]*?No pending invitations\./);
  });

  it('FR-ACC-10 (helper): S-22 marks a member whose account was created from a shown link', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} members={[{ ...m1, createdFromShownLink: true }, { ...m2, createdFromShownLink: false }]} />);
    const rowOf = (name: string) => text(html.split('<tr').slice(1).find((r) => r.includes(name))!);
    expect(rowOf(m1.name)).toContain('account created from a copied link');
    expect(rowOf(m2.name)).not.toContain('account created from a copied link');
  });
});
