import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CopyLinkFallback } from '@/components/invitations/CopyLinkFallback';

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
  it('UX-23: when the email could not be sent, the page says so in a status region', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl="https://h/invitations/t" expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} />);
    expect(html).toMatch(/<[a-z]+[^>]*role="status"[^>]*>[^<]*The invitation email could not be sent\. Send this link another way\./);
  });
  it('UX-23: no link shown and the email failed: the Resend and show link button is rendered', () => {
    const html = renderToStaticMarkup(<CopyLinkFallback acceptUrl={null} expiresAt="2026-11-04T09:00:00.000Z" emailSent={false} onResendWithLink={() => {}} />);
    expect(buttonsOf(html).map((b) => b.name)).toContain('Resend and show link');
    expect(buttonsOf(html).map((b) => b.name)).not.toContain('Copy link');
  });
});
