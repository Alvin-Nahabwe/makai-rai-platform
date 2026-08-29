import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The nginx real-IP configuration, guarded.
 *
 * `set_real_ip_from` is a security boundary, not a convenience list: an address
 * absent from it cannot influence `$remote_addr` at all, and an address wrongly
 * present can set it to anything. Three separate consumers depend on it being
 * right -- the `limit_req_zone`s (which key on `$binary_remote_addr`),
 * `X-Real-IP`, and the `X-Forwarded-For` that `proxy.ts` reads for rate-limit
 * and audit identity.
 *
 * The failure this file most expects is not a wrong range but a TRUNCATED list
 * or a reverted header, either of which is silent: requests from an unlisted
 * Cloudflare range keep Cloudflare's own address, and every visitor behind that
 * edge collapses into a single rate-limit bucket with no error anywhere.
 *
 * The list is duplicated across repositories -- here and
 * `HETZNER_FIREWALL_SETUP.md` §4 in toolkit-process, which feeds the Hetzner
 * firewall. Nothing can compare them in CI, since neither repository checks the
 * other out. That is stated rather than hidden; this file guards the half that
 * is reachable.
 */

const CONF = readFileSync('docker/nginx/default.conf', 'utf8');

function realIpSources(): string[] {
  return [...CONF.matchAll(/^set_real_ip_from\s+(\S+);/gm)].map((m) => m[1]);
}

describe('nginx restores the real client address safely', () => {
  it('lists a plausible number of sources, so a truncated list fails loudly', () => {
    // Cloudflare published 15 IPv4 and 7 IPv6 ranges on 2026-08-29. A floor
    // rather than an exact count: they add ranges, and a legitimate addition
    // must not fail CI. Losing most of the list must.
    const sources = realIpSources();
    expect(sources.length, 'set_real_ip_from list looks truncated').toBeGreaterThanOrEqual(20);
  });

  it('covers both address families, since the origin has a public IPv6', () => {
    const sources = realIpSources();
    expect(sources.some((s) => s.includes(':')), 'no IPv6 ranges: Cloudflare will reach the v6 address and be unrecognised').toBe(true);
    expect(sources.some((s) => !s.includes(':')), 'no IPv4 ranges').toBe(true);
  });

  it('has no malformed entry, which nginx would reject at startup', () => {
    const bad = realIpSources().filter(
      (s) => !/^(\d{1,3}(\.\d{1,3}){3}|[0-9a-fA-F:]+)\/\d{1,3}$/.test(s),
    );
    expect(bad, `malformed set_real_ip_from entries: ${bad.join(', ')}`).toEqual([]);
  });

  it('trusts CF-Connecting-IP, not a client-writable list header', () => {
    // X-Forwarded-For is a chain the client can prepend to. CF-Connecting-IP is
    // a single value Cloudflare overwrites on every proxied request.
    expect(CONF).toMatch(/^real_ip_header\s+CF-Connecting-IP;/m);
    expect(
      /^real_ip_header\s+X-Forwarded-For;/m.test(CONF),
      'real_ip_header was switched to X-Forwarded-For, which the client controls',
    ).toBe(false);
  });

  it('overwrites X-Forwarded-For rather than appending to it', () => {
    // $proxy_add_x_forwarded_for PREPENDS whatever the client sent, and
    // proxy.ts reads the first element -- so appending hands identity straight
    // back to the client. This is the exact line that was wrong at three sites.
    const appending = [...CONF.matchAll(/proxy_set_header\s+X-Forwarded-For\s+\$proxy_add_x_forwarded_for;/g)];
    expect(
      appending.length,
      'X-Forwarded-For is being APPENDED. proxy.ts reads the first element, so ' +
        'the client controls it again. Use $remote_addr.',
    ).toBe(0);
    expect([...CONF.matchAll(/proxy_set_header\s+X-Forwarded-For\s+\$remote_addr;/g)].length)
      .toBeGreaterThan(0);
  });
});
