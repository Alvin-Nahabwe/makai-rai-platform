import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';
import { COPY_LINK_COPY } from '@/lib/invitations/link/copy';
import { MEMBERS_COPY } from '@/lib/org/members/copy';
import { memberRoleWords } from '@/lib/org/copy';
import { escapeRe } from '../helpers/escapeRe';
import MembersManager, { invitedWords } from '@/app/(authenticated)/orgs/[slug]/settings/members/MembersManager';
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
    const copy = buttonsOf(html).find((b) => b.name === COPY_LINK_COPY.copy)!;
    expect(copy.attrs).toMatchObject({ type: 'button' });
    expect(copy.attrs).not.toHaveProperty('disabled');
    expect(text(html)).toContain('The link works once and expires on 4 Nov 2026.');
  });
  it('UX-23 NFR-A11Y-05: the box mounts with an empty status region (a region inserted with text is not announced), and the failure sentence is plain text', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl="https://h/invitations/t" expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} />);
    expect(html).toMatch(/<div role="status" class="ui-status"><\/div>/);
    expect(html).toMatch(/<p>The invitation email could not be sent\. Send this link another way\.<\/p>/);
  });
  it('UX-23: when the page announces the failure sentence itself, the box does not repeat it', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl="https://h/invitations/t" expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} noticeShownElsewhere />);
    expect(html).not.toContain('could not be sent');
    expect(html).toMatch(/<div role="status" class="ui-status"><\/div>/);
  });
  it('UX-23: no link shown and the email failed: the Resend and show link button is rendered', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl={null} expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} onResendWithLink={() => {}} />);
    expect(buttonsOf(html).map((b) => b.name)).toContain(COPY_LINK_COPY.resend);
    expect(buttonsOf(html).map((b) => b.name)).not.toContain(COPY_LINK_COPY.copy);
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
const common = { slug: 'acme', members: [m1, m2], invitations: [pending], roleWords: memberRoleWords() };
const ownerProps = { ...common, currentUserId: m1.userId, currentRole: 'owner' as const };
const adminProps = { ...common, currentUserId: 'u-admin', currentRole: 'admin' as const };
const viewerProps = { ...common, currentUserId: m2.userId, currentRole: 'viewer' as const, invitations: [] };

describe('S-22 MembersManager', () => {
  it('UX-29 FR-MEM-04 FR-MEM-02: each member row and invitation row has an action button that names its object, and no dialog or open confirmation is rendered', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} />);
    const names = buttonsOf(html).map((b) => b.name);
    expect(names).toEqual(expect.arrayContaining([MEMBERS_COPY.members.removeName(m2.name), MEMBERS_COPY.invitations.cancelTo(pending.email)]));
    expect(names).not.toContain(MEMBERS_COPY.members.removeAction);
    expect(names).not.toContain(MEMBERS_COPY.invitations.confirmAction);
    expect(html).not.toMatch(/role="dialog"|<dialog/);
  });

  it('FR-MEM-02: a viewer sees no pending invitations and no invite control, and can leave', () => {
    const html = renderToStaticMarkup(<MembersManager {...viewerProps} />);
    expect(html).not.toContain(MEMBERS_COPY.invitations.caption);
    expect(buttonsOf(html).filter((b) => /Invite/.test(b.name))).toEqual([]);
    const leave = buttonsOf(html).find((b) => b.name === MEMBERS_COPY.leave.trigger)!;
    expect(leave).toBeDefined();
    expect(leave.attrs).not.toHaveProperty('disabled');
  });

  it("FR-MEM-01 FR-MEM-03: an admin's role list has no owner option", () => {
    const html = renderToStaticMarkup(<MembersManager {...adminProps} />);
    const id = new RegExp(`<label[^>]*for="([^"]+)"[^>]*>${escapeRe(MEMBERS_COPY.invite.roleLabel)}<`).exec(html)?.[1];
    const options = [...(new RegExp(`<select[^>]*id="${id}"[^>]*>([\\s\\S]*?)</select>`).exec(html)?.[1] ?? '').matchAll(/<option\b[^>]*value="([^"]*)"[^>]*>([^<]*)<\/option>/g)]
      .map((x) => ({ value: x[1], label: x[2] }));
    // Ruling L5-18: the options now read words ("Admin"), so the check is on the values (the keys the route takes) and on
    // the labels (the vocabulary's words) both; a check on one alone would pass with the other wrong.
    expect(options.map((o) => o.value)).toEqual(['', 'admin', 'assessor', 'reviewer', 'viewer']);
    expect(options.map((o) => o.label)).toEqual([MEMBERS_COPY.invite.rolePlaceholder, 'Admin', 'Assessor', 'Reviewer', 'Viewer']);
    expect(options.map((o) => o.value)).not.toContain('owner');
    expect(options.map((o) => o.label)).not.toContain('Owner');
  });

  it('FR-MEM-02 (7.4.2 S-22): with no invitation the table, named by its caption, says "No pending invitations."', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} invitations={[]} />);
    expect(html).toMatch(new RegExp(`<table[^>]*>\\s*<caption[^>]*>${escapeRe(MEMBERS_COPY.invitations.caption)}</caption>[\\s\\S]*?${escapeRe(MEMBERS_COPY.invitations.none)}`));
  });

  it('FR-ACC-10 (helper): S-22 marks a member whose account was created from a shown link', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} members={[{ ...m1, createdFromShownLink: true }, { ...m2, createdFromShownLink: false }]} />);
    const rowOf = (name: string) => text(html.split('<tr').slice(1).find((r) => r.includes(name))!);
    expect(rowOf(m1.name)).toContain(MEMBERS_COPY.members.copiedLink.trim());
    expect(rowOf(m2.name)).not.toContain(MEMBERS_COPY.members.copiedLink.trim());
  });

  it('FR-ACC-10 (workshop walk S12-c): the copied-link mark stands on its own line under the name, small and muted, not run into it', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} members={[{ ...m1, createdFromShownLink: true }]} />);
    expect(html.replace(/<!-- -->/g, '')).toContain(`${m1.name}${MEMBERS_COPY.members.you}<span class="members-mark">${MEMBERS_COPY.members.copiedLink}</span>`);
    const css = readFileSync('app/(authenticated)/orgs/[slug]/settings/members/MembersManager.css', 'utf8');
    const rule = css.match(/\.members-mark \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/display: block;/);
    expect(rule).toMatch(/font-size: var\(--font-size-small\);/);
    expect(rule).toMatch(/color: var\(--color-ink-muted\);/);
  });

  it('NFR-A11Y-05 (A11Y-4): the Leave control is not part of the members table', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} />);
    expect(html.slice(0, html.indexOf('</table>'))).not.toContain(MEMBERS_COPY.leave.trigger);
    expect(html.slice(html.indexOf('</table>'))).toContain(MEMBERS_COPY.leave.trigger);
  });

  it('FR-ACC-10 (A11Y-5): the Show link checkbox of the invite form is described by what showing the link means', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} />);
    const box = tagsOf(html, 'input').find((a) => a.type === 'checkbox' && a['aria-describedby'])!;
    expect(box).toBeDefined();
    // The kit's Checkbox writes its hint as a div (plan 1A Task 19); the property is the description, not the tag.
    expect(html).toMatch(new RegExp(`<(p|div)[^>]*id="${box['aria-describedby']}"[^>]*>${escapeRe(MEMBERS_COPY.invite.showLinkHint)}</(p|div)>`));
  });

  /** The invite form's role choice: the marked wrapper, the select inside it and the definition lines under the select. */
  const roleChoice = (html: string) => {
    const choice = /<div data-role-choice="">([\s\S]*?)<\/form>/.exec(html)?.[1] ?? '';
    const select = /<select[^>]*id="invite-role"[^>]*>/.exec(choice)?.[0] ?? '';
    const afterSelect = choice.slice(choice.indexOf('</select>'));
    const lines = [...afterSelect.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((x) => x[1]);
    return { choice, select, afterSelect, lines };
  };
  const lineOf = (role: 'owner' | 'admin' | 'assessor' | 'reviewer' | 'viewer') => {
    const { entry } = memberRoleWords()[role];
    return `<span data-term="${entry.id}">${entry.term}</span> <span class="ui-definition" data-definition="${entry.id}">${entry.definition}</span>`;
  };

  it('FR-MEM-01 (OR28, Q11, ruling L5-22 as revised): under an Owner\'s role select, each of the five roles is listed with the vocabulary\'s definition beside its term, in the element marked as a role choice', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} />);
    const { select, lines } = roleChoice(html);
    expect(select).not.toBe('');
    expect(lines).toEqual((['owner', 'admin', 'assessor', 'reviewer', 'viewer'] as const).map(lineOf));
    // The per-member selects in the table are not a role choice: only the invite form's field is marked.
    expect(html.match(/data-role-choice/g)).toHaveLength(1);
    expect(html.indexOf('data-role-choice')).toBeGreaterThan(html.lastIndexOf('</table>'));
  });

  it('FR-MEM-01 (OR28, ruling L5-22 as revised): an Admin is read the four roles the select offers, and no Owner line', () => {
    const { lines, afterSelect } = roleChoice(renderToStaticMarkup(<MembersManager {...adminProps} />));
    expect(lines).toEqual((['admin', 'assessor', 'reviewer', 'viewer'] as const).map(lineOf));
    expect(afterSelect).not.toContain('data-term="owner"');
    expect(afterSelect).not.toContain('data-definition="owner"');
  });

  it('FR-MEM-01 (react M-3): the role select is described by its error only, never by the list of definitions', () => {
    const { select, choice } = roleChoice(renderToStaticMarkup(<MembersManager {...ownerProps} />));
    expect(select).not.toMatch(/aria-describedby="[^"]*hint/);
    expect(choice).not.toContain('id="invite-role-hint"');
    const listId = /<ul[^>]*id="([^"]+)"/.exec(choice)?.[1];
    if (listId !== undefined) expect(select).not.toContain(listId);
  });

  it('UX-23 (answer Q21): after an invite or a resend whose email failed, the sentence names the link when it is shown, and the button when it is not', () => {
    const NO_LINK = 'The invitation email could not be sent. Select Send the email again and show the link.';
    expect(COPY_LINK_COPY.emailFailedNoLink).toBe(NO_LINK);
    expect(invitedWords({ invitation: pending, acceptUrl: 'https://h/invitations/t', emailSent: false })).toBe(COPY_LINK_COPY.emailFailed);
    expect(invitedWords({ invitation: pending, acceptUrl: null, emailSent: false })).toBe(NO_LINK);
    expect(invitedWords({ invitation: pending, acceptUrl: null, emailSent: true })).toBe(MEMBERS_COPY.sent(pending.email));
    // With no link the box offers the button the sentence names.
    const box = renderToStaticMarkup(<CopyLinkFallback acceptUrl={null} expiresAt={pending.expiresAt} emailSent={false} noticeShownElsewhere onResendWithLink={() => {}} />);
    expect(buttonsOf(box).map((x) => x.name)).toContain(COPY_LINK_COPY.resend);
  });

  it('FR-MEM-03 (OR21, copy review 7): the role-change sentence takes "an" before a vowel and "a" before a consonant', () => {
    const words = memberRoleWords();
    expect(MEMBERS_COPY.roleChanged('Okello James', words.admin.withArticle)).toBe('Okello James is now an Admin. The change takes effect at once.');
    expect(MEMBERS_COPY.roleChanged('Okello James', words.owner.withArticle)).toBe('Okello James is now an Owner. The change takes effect at once.');
    expect(MEMBERS_COPY.roleChanged('Okello James', words.assessor.withArticle)).toBe('Okello James is now an Assessor. The change takes effect at once.');
    expect(MEMBERS_COPY.roleChanged('Okello James', words.reviewer.withArticle)).toBe('Okello James is now a Reviewer. The change takes effect at once.');
  });

  it('FR-MEM-03 (OR28): a member\'s role reads as the vocabulary\'s word, never as the raw value, while the select keeps the raw value', () => {
    const html = renderToStaticMarkup(<MembersManager {...ownerProps} />);
    expect(html).toMatch(/<option value="viewer" selected="">Viewer<\/option>/);
    expect(text(html)).not.toMatch(/\b(owner|admin|assessor|reviewer|viewer)\b/);
  });
});
