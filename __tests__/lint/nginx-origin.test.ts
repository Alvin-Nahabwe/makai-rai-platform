import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseNginx, rawDirectives, walk, type NginxNode } from './helpers/nginx-conf';

/**
 * Who the origin talks to, and what it writes down about them.
 *
 * Three controls trust `CF-Connecting-IP` (the rate-limit zones, `X-Real-IP`,
 * and the `X-Forwarded-For` that proxy.ts reads). That header is only
 * trustworthy when the request really came from Cloudflare. This file pins the
 * check nginx makes itself, which holds whatever sits in front of the host:
 *
 *   1. The origin keys its admit/refuse decision on the CONNECTION address.
 *      nginx's realip module rewrites `$remote_addr` before the access phase, so
 *      an `allow`/`deny` list of Cloudflare ranges would compare the visitor's
 *      address against Cloudflare's and refuse every real user. `geo` over
 *      `$realip_remote_addr` looks at the socket, which is what must be checked.
 *   2. A request for any host nginx does not serve is dropped, and a TLS
 *      handshake for an unknown name is rejected without needing a certificate.
 *   3. The access log records no user agent, no referer, no query string and no
 *      invitation token, so a log line cannot carry an email or a bearer secret.
 *
 * Structural, like security-headers.test.ts: where a directive sits in the block
 * tree is the property, so the file is parsed rather than grepped. A grep for
 * `return 444` passes just as happily when it sits in a location, or after the
 * `return 301` that already ended the request.
 *
 * What this cannot prove is that nginx accepts the file. `nginx -t` runs at
 * deploy, where the certificate paths exist.
 */

const source = readFileSync('docker/nginx/default.conf', 'utf8');
const conf = parseNginx(source);
const all = walk(conf);

const servers = conf.filter((n) => n.name === 'server');
const childrenOf = (server: NginxNode, name: string) =>
  (server.children ?? []).filter((d) => d.name === name);
const portOf = (listenArg: string) => listenArg.match(/(?:^|:)(\d+)$/)?.[1];
/** `address:port` as nginx distinguishes sockets: `80` is `*:80`, `0.0.0.0` is the same
 * wildcard, and `[::]:80` is a different socket. An address without a port means 80. */
function listenKey(arg: string): string {
  if (/^\d+$/.test(arg)) return `*:${arg}`;
  const m = arg.match(/^(\[[^\]]*\]|[^:]+):(\d+)$/);
  if (!m) return `${arg}:80`;
  return `${m[1] === '0.0.0.0' ? '*' : m[1]}:${m[2]}`;
}
const hasPort = (server: NginxNode, port: string) =>
  childrenOf(server, 'listen').some((l) => portOf(l.args[0]) === port);

/** The `server_name makrai.org` blocks: the port-80 redirect and the TLS server. */
const makraiServers = servers.filter((s) =>
  childrenOf(s, 'server_name').some((d) => d.args.includes('makrai.org')),
);

/** The addresses nginx will accept `CF-Connecting-IP` from. The geo block must equal this. */
const realIpSources = conf.filter((n) => n.name === 'set_real_ip_from').map((n) => n.args[0]);

function geoBlock(): NginxNode {
  const found = conf.filter((n) => n.name === 'geo' && n.args[1] === '$from_cloudflare');
  expect(found, 'expected exactly one top-level `geo ... $from_cloudflare` block').toHaveLength(1);
  return found[0];
}

describe('the origin admits only Cloudflare', () => {
  it('origin trust keys on the connection address', () => {
    // Keyed on `$realip_remote_addr`, the socket's peer. `$remote_addr` is rewritten
    // to the visitor by realip before this runs, so keying on it refuses everyone.
    const geo = geoBlock();
    expect(geo.args[0], 'geo must key on $realip_remote_addr, not the rewritten $remote_addr').toBe(
      '$realip_remote_addr',
    );

    const entries = geo.children ?? [];
    const def = entries.filter((e) => e.name === 'default');
    expect(def.map((e) => e.args), 'geo needs one `default 0;`: unknown means refused').toEqual([
      ['0'],
    ]);
    const ranges = entries.filter((e) => e.name !== 'default');
    expect(
      ranges.filter((e) => e.args.join(' ') !== '1').map((e) => e.name),
      'every geo range must map to 1',
    ).toEqual([]);

    // Derived from the file, not hard-coded: Cloudflare adds ranges, and the list
    // that matters is whatever `set_real_ip_from` trusts. A geo range that realip
    // does not trust, or the reverse, is a bug in one direction or the other.
    // An empty pair would be equal and prove nothing.
    expect(realIpSources.length, 'no set_real_ip_from entries found').toBeGreaterThan(0);
    expect(
      ranges.map((e) => e.name).sort(),
      'geo $from_cloudflare ranges must equal the set_real_ip_from list exactly (IPv4 and IPv6)',
    ).toEqual([...realIpSources].sort());

    // Both makrai.org servers refuse a non-Cloudflare connection. Directly in the
    // server block, never in a location: a location is only reached after the TLS
    // server has already chosen to answer, and an `if` there is the documented trap.
    expect(
      makraiServers.filter((s) => hasPort(s, '80')),
      'expected one port-80 makrai.org server',
    ).toHaveLength(1);
    expect(
      makraiServers.filter((s) => hasPort(s, '443')),
      'expected one port-443 makrai.org server',
    ).toHaveLength(1);
    expect(makraiServers, 'expected no other makrai.org server').toHaveLength(2);

    for (const server of makraiServers) {
      const where = hasPort(server, '443') ? 'port-443' : 'port-80';
      const gates = (server.children ?? []).filter(
        (d) => d.name === 'if' && d.args.join(' ') === '($from_cloudflare = 0)',
      );
      expect(gates, `${where} makrai.org server needs exactly one \`if ($from_cloudflare = 0)\``)
        .toHaveLength(1);
      expect(
        gates[0].children?.map((c) => [c.name, ...c.args]),
        `${where}: the gate must be \`return 444;\` and nothing else`,
      ).toEqual([['return', '444']]);

      // Rewrite-phase directives run in file order and the first `return` ends the
      // request. In the port-80 server the redirect is a `return` too: a gate written
      // below it never runs, and every non-Cloudflare client is redirected, not dropped.
      // Position is judged for the gate itself, not for "the first `if`": anything that
      // can answer, rewrite or end the rewrite phase (`return`, `rewrite`, `break`,
      // another `if`) above the gate lets a request out before the gate has looked at it.
      const siblings = server.children ?? [];
      const above = siblings
        .slice(0, siblings.indexOf(gates[0]))
        .filter((d) => ['return', 'rewrite', 'break', 'if'].includes(d.name));
      expect(
        above.map((d) => [d.name, ...d.args].join(' ')),
        `${where}: nothing that can answer or end processing may sit above the $from_cloudflare gate`,
      ).toEqual([]);
    }

    // Never inside a location.
    const gatesInLocations = all.filter(
      ({ node, ancestors }) =>
        node.name === 'if' &&
        node.args.join(' ').includes('$from_cloudflare') &&
        ancestors.some((a) => a.name === 'location'),
    );
    expect(gatesInLocations, 'the Cloudflare gate must not sit inside a location').toEqual([]);
  });

  it('never filters with allow/deny, and never keys a geo or map on the rewritten address', () => {
    // allow/deny compare `$remote_addr`, which realip has already rewritten to the
    // visitor. A Cloudflare allow-list there refuses every real user; a deny-list
    // there trusts a header the client may have sent.
    const accessRules = all.filter(({ node }) => node.name === 'allow' || node.name === 'deny');
    expect(
      accessRules.map(({ node }) => `${node.name} ${node.args.join(' ')}`),
      'allow/deny act on the rewritten $remote_addr; use the geo gate',
    ).toEqual([]);

    const keyedOnRewritten = all.filter(
      ({ node, ancestors }) =>
        ancestors.length === 0 &&
        (node.name === 'geo' || node.name === 'map') &&
        /^\$(binary_)?remote_addr$/.test(node.args[0] ?? ''),
    );
    expect(keyedOnRewritten.map(({ node }) => node.args), 'no geo/map may key on $remote_addr').toEqual(
      [],
    );
  });

  it('unknown hosts are refused', () => {
    // Exactly one default_server per ADDRESS:PORT, in the whole file. Two on one is an
    // nginx startup error; none means the first server listening there takes every
    // request whose Host matches nothing, which is makrai.org. A port is not enough:
    // `listen [::]:443 ssl;` is a different socket from `listen 443 ssl;` and needs
    // its own default.
    const listeners = servers.flatMap((server) =>
      childrenOf(server, 'listen').map((l) => ({
        server,
        key: listenKey(l.args[0]),
        port: portOf(l.args[0]),
        args: l.args,
        isDefault: l.args.includes('default_server'),
      })),
    );
    // No makrai.org block listens somewhere the default block does not cover, and
    // none is itself the default. A makrai.org listener without a default beside it
    // would make makrai.org answer every Host on that socket.
    for (const l of listeners.filter((l) => makraiServers.includes(l.server))) {
      expect(l.isDefault, `a makrai.org server must not claim default_server (${l.key})`).toBe(false);
      expect(
        listeners.some((d) => d.key === l.key && d.isDefault && !makraiServers.includes(d.server)),
        `makrai.org listens on ${l.key}, which has no default_server in another block`,
      ).toBe(true);
    }

    const keys = [...new Set(listeners.map((l) => l.key))];
    expect(keys, 'the origin must listen on 80 and 443').toEqual(
      expect.arrayContaining(['*:80', '*:443']),
    );
    for (const key of keys) {
      const claims = listeners.filter((l) => l.key === key && l.isDefault);
      expect(claims, `exactly one default_server on ${key}`).toHaveLength(1);
    }

    // One block holds every default claim.
    const holders = [...new Set(listeners.filter((l) => l.isDefault).map((l) => l.server))];
    expect(holders, 'one block must hold every default_server').toHaveLength(1);
    const fallback = holders[0];

    for (const l of listeners.filter((l) => l.server === fallback && l.port === '443')) {
      expect(l.args, `the ${l.key} listener of the default block must be ssl`).toContain('ssl');
    }
    expect(
      childrenOf(fallback, 'ssl_reject_handshake').map((d) => d.args),
      'ssl_reject_handshake on: no certificate is offered for an unknown name',
    ).toEqual([['on']]);
    expect(childrenOf(fallback, 'return').map((d) => d.args)).toEqual([['444']]);

    // And it is not one of the real servers.
    expect(makraiServers).not.toContain(fallback);
    expect(
      childrenOf(fallback, 'server_name'),
      'the default block must not name makrai.org (or anything)',
    ).toEqual([]);
  });
});

describe('the access log keeps no emails and no tokens', () => {
  // Read from the raw text, not from the parsed tree. nginx treats `${name}` as a
  // variable wherever it appears, including as an unquoted argument that the block
  // parser would take for a `{`, and it ends a variable name at the end of an
  // argument, so `"$request" "_method"` logs the full request line. Each log_format
  // is taken from its keyword to its `;`, across all of its arguments.
  const rawFormats = rawDirectives(source, 'log_format');
  const makrai = rawFormats.filter((raw) => /^log_format\s+makrai\s/.test(raw));
  // Every variable reference in a directive's raw text: `$name` and `${name}`.
  const referenced = (raw: string) => [...raw.matchAll(/\$\{?([A-Za-z0-9_]+)\}?/g)].map((m) => m[1]);

  it('access log carries no user agent, referer, query or invitation token', () => {
    expect(makrai, 'expected exactly one `log_format makrai`').toHaveLength(1);

    // A reference is `$name` or `${name}` not followed by a name character, so
    // `$request_method` is fine and `$request`, `${request}` are not. Applied to every
    // log_format in the file: one that nothing uses today could be wired in tomorrow.
    const forbidden: Record<string, string> = {
      http_user_agent: 'the user agent',
      http_referer: 'the referer',
      args: 'the query string',
      query_string: 'the query string',
      request: 'the full request line, query string included',
      request_uri: 'the raw URI, query string included',
      uri: 'the raw path; log $log_uri, which has the token removed',
    };
    for (const raw of rawFormats) {
      for (const [name, why] of Object.entries(forbidden)) {
        const reference = new RegExp(`\\$\\{?${name}\\}?(?![A-Za-z0-9_])`);
        expect(raw, `$${name} (${why}) must not be logged, in either $name or \${name} form`).not.toMatch(
          reference,
        );
      }
    }
    expect(referenced(makrai[0]), 'the path must be logged as $log_uri').toContain('log_uri');
  });

  it('logs only variables that are known not to carry an email or a token', () => {
    // The denylist above names what we know about; this fails on what we do not.
    // Adding a variable to the format is a privacy decision, so it is made here.
    const allowed = [
      'remote_addr',
      'time_iso8601',
      'request_method',
      'log_uri',
      'server_protocol',
      'status',
      'body_bytes_sent',
      'request_time',
    ];
    expect(makrai, 'expected exactly one `log_format makrai`').toHaveLength(1);
    const logged = referenced(makrai[0]);
    expect(logged.length, 'no variables found in log_format makrai').toBeGreaterThan(0);
    expect(logged.filter((name) => !allowed.includes(name))).toEqual([]);
  });

  it('redacts the invitation token from the logged path', () => {
    const maps = conf.filter((n) => n.name === 'map' && n.args.join(' ') === '$uri $log_uri');
    expect(maps, 'expected exactly one top-level `map $uri $log_uri`').toHaveLength(1);
    const entries = maps[0].children ?? [];

    // Evaluate the file's own regex, the way nginx would. PCRE and JavaScript agree
    // on this pattern's syntax (named groups, `[^/]+`, anchors).
    const rule = entries.find((e) => e.name.startsWith('~'));
    expect(rule, 'the map has no regex rule').toBeDefined();
    const pattern = new RegExp(rule!.name.slice(1));
    const dflt = entries.find((e) => e.name === 'default');
    expect(dflt?.args, 'the map must fall through to the plain path').toEqual(['$uri']);

    const logged = (uri: string) => {
      const m = pattern.exec(uri);
      if (!m) return uri;
      return rule!.args[0].replace(/\$(\w+)/g, (_, n: string) => m.groups?.[n] ?? '');
    };

    const inviteId = 'sample-invite-0001';
    // Both token-bearing routes: the public page and the API, with and without a tail.
    expect(logged(`/invitations/${inviteId}`)).toBe('/invitations/[token]');
    expect(logged(`/api/v1/invitations/${inviteId}`)).toBe('/api/v1/invitations/[token]');
    expect(logged(`/api/v1/invitations/${inviteId}/register`)).toBe(
      '/api/v1/invitations/[token]/register',
    );
    // Everything else is logged as it is.
    expect(logged('/login')).toBe('/login');
    expect(logged('/api/v1/orgs/acme/assessments')).toBe('/api/v1/orgs/acme/assessments');
    expect(logged('/invitations')).toBe('/invitations');
    for (const uri of [`/invitations/${inviteId}`, `/api/v1/invitations/${inviteId}/register`]) {
      expect(logged(uri), 'the invitation id must not survive into the log').not.toContain(inviteId);
    }
  });

  it('every server logs in the makrai format, and nothing logs in any other', () => {
    // `access_log` directives at one level ADD to each other and a level that has
    // none inherits the level above. The stock nginx.conf declares
    // `access_log ... main;` (user agent, referer, full request line) at http
    // level, so an access_log at http level here would be written ALONGSIDE it. A
    // server-level access_log replaces what it inherits, so every server, the
    // default block included, names the makrai format itself.
    const logs = all.filter(({ node }) => node.name === 'access_log');
    expect(
      logs.filter(({ node }) => node.args[1] !== 'makrai').map(({ node }) => node.args.join(' ')),
      'every access_log must use the makrai format (not combined, main or off)',
    ).toEqual([]);

    expect(servers.length, 'expected three servers').toBe(3);
    for (const server of servers) {
      const own = childrenOf(server, 'access_log');
      expect(
        own.map((d) => d.args),
        `a server block without its own access_log inherits the http-level format: ` +
          `${childrenOf(server, 'listen').map((l) => l.args.join(' ')).join(', ')}`,
      ).toEqual([['/var/log/nginx/access.log', 'makrai']]);
    }
  });
});
