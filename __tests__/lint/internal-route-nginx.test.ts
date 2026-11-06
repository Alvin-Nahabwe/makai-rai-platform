import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNginx, type NginxNode } from './helpers/nginx-conf';

/**
 * NFR-SEC-13, FR-OPS-02 (SRS line 1149; line 1434): nginx refuses /api/internal/ in the server that
 * proxies the app, so the reminder route can be reached from inside the container only. Structural, like
 * nginx-origin.test.ts: where the location sits is the property, so the file is parsed, not grepped.
 * `^~` is what stops a regex location from winning over the prefix (nginx documentation of `location`;
 * the file has none today, and this test pins that too).
 *
 * Also pins two directives of the same server that OPS owns: `proxy_set_header X-Pathname ""` (defence in
 * depth next to proxy.ts, which overwrites the header on pages and drops it on /api/*), and HTTP/2 on the
 * TLS listener (NFR-PERF-02: it lowers per-response header bytes; Cloudflare to the origin is unaffected).
 */

const conf = parseNginx(readFileSync('docker/nginx/default.conf', 'utf8'));
const servers = conf.filter((n) => n.name === 'server');
const childrenOf = (n: NginxNode, name: string) => (n.children ?? []).filter((d) => d.name === name);
const listens = (s: NginxNode, port: string) => childrenOf(s, 'listen').some((l) => l.args[0] === port || l.args[0].endsWith(`:${port}`));
const isDefaultServer = (s: NginxNode) => childrenOf(s, 'listen').some((l) => l.args.includes('default_server'));
const https = () => servers.find((s) => listens(s, '443') && !isDefaultServer(s))!;

describe('nginx and the internal route', () => {
  it('NFR-SEC-13: nginx refuses /api/internal/ in the server that proxies the app', () => {
    const locs = childrenOf(https(), 'location');
    const i = locs.findIndex((l) => l.args.join(' ') === '^~ /api/internal/');
    expect(i).toBeGreaterThanOrEqual(0);
    expect(childrenOf(locs[i], 'return').map((r) => r.args)).toEqual([['404']]);
    expect(childrenOf(locs[i], 'proxy_pass')).toEqual([]);
    expect(i).toBeLessThan(locs.findIndex((l) => l.args.join(' ') === '/'));
  });

  it('NFR-SEC-13: no regex location exists in that server, so nothing can win over the refusal', () => {
    const regex = childrenOf(https(), 'location').filter((l) => l.args[0] === '~' || l.args[0] === '~*');
    expect(regex.map((l) => l.args)).toEqual([]);
  });

  it('NFR-SEC-13: the port-80 server only redirects and the default server proxies nothing', () => {
    for (const s of servers.filter((x) => x !== https())) expect(childrenOf(s, 'location').flatMap((l) => childrenOf(l, 'proxy_pass'))).toEqual([]);
  });

  it('NFR-SEC-02: every proxying location clears X-Pathname, so a client-sent header never reaches the app', () => {
    const proxying = childrenOf(https(), 'location').filter((l) => childrenOf(l, 'proxy_pass').length > 0);
    expect(proxying.length).toBeGreaterThan(0);
    for (const l of proxying) {
      const set = childrenOf(l, 'proxy_set_header').filter((d) => d.args[0].toLowerCase() === 'x-pathname');
      expect({ location: l.args.join(' '), set: set.map((d) => d.args) }).toEqual({ location: l.args.join(' '), set: [['X-Pathname', '']] });
    }
  });

  it('NFR-PERF-02: the TLS server speaks HTTP/2', () => {
    expect(childrenOf(https(), 'http2').map((d) => d.args)).toEqual([['on']]);
    expect(childrenOf(https(), 'listen').every((l) => !l.args.includes('http2'))).toBe(true); // the deprecated listen flag is not used
  });
});
