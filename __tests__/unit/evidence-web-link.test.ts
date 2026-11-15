import { describe, expect, it } from 'vitest';
import { webLink } from '@/lib/evidence/format';

/**
 * webLink (lib/evidence/format.ts): a stored evidence address parsed ONCE, so the href a reader follows and the host the
 * reader is shown come from the same parse (link spoofing; coordinator's security ruling of 15 November 2026). Anything
 * that is not an http or https URL is null, for the caller to show as text and never as a link.
 */
describe('webLink', () => {
  it('gives the parsed href and its host for an ordinary web address', () => {
    expect(webLink('https://example.org/walk/report.pdf')).toEqual({ href: 'https://example.org/walk/report.pdf', host: 'example.org' });
    expect(webLink('http://example.org')).toEqual({ href: 'http://example.org/', host: 'example.org' });
  });

  it('"https:evil.example" (relative in a browser without the slashes) yields the host its own href goes to', () => {
    const link = webLink('https:evil.example');
    expect(link).not.toBeNull();
    expect(new URL(link!.href).hostname).toBe(link!.host);
    expect(link!.host).toBe('evil.example');
    expect(link!.href).toBe('https://evil.example/');
  });

  it('a user name or password before the real host never becomes the host shown', () => {
    expect(webLink('https://good.example@evil.example/x')?.host).toBe('evil.example');
    expect(webLink('https://good.example:pw@evil.example/x')?.host).toBe('evil.example');
    expect(webLink('https://evil.example#@good.example')?.host).toBe('evil.example');
    expect(webLink('https://evil.example?@good.example')?.host).toBe('evil.example');
  });

  it('a look-alike international name is shown in punycode, as the browser resolves it', () => {
    expect(webLink('https://раypal.example/')?.host).toMatch(/^xn--/);
  });

  it('IPv6 and numeric hosts are shown as the browser resolves them, without the port', () => {
    expect(webLink('https://[2001:db8::1]:8443/x')?.host).toBe('[2001:db8::1]');
    expect(webLink('http://127.1/')?.host).toBe('127.0.0.1');
  });

  it('a host carrying bidi controls (E14) is no web link at all: the URL parser refuses it, so it is never an anchor', () => {
    expect(webLink('https://ex‮ample.org/')).toBeNull();
    expect(webLink('https://example.org⁦/')).toBeNull();
  });

  it('is null for anything that is not an http or https URL, so the caller shows it as text', () => {
    for (const bad of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,<b>x</b>', 'blob:https://example.org/1', 'ftp://example.org/', '/relative/path', '//evil.example/x', 'not a url', '']) {
      expect(webLink(bad)).toBeNull();
    }
  });
});
