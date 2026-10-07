import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * The security headers have exactly one author: nginx.
 *
 * Before this guard the same headers were served twice, once by
 * `docker/nginx/default.conf` and once by `next.config.ts`'s `headers()`, and the
 * two copies had drifted: nginx carried a Content-Security-Policy with
 * `'unsafe-eval'`, Google Fonts hosts the app no longer loads from (next/font
 * self-hosts the files), and no `connect-src`, `object-src`, `base-uri`,
 * `form-action` or `frame-ancestors` at all. A header sent twice is not a
 * stronger header, it is two things to keep in step, and the one nobody reads
 * is the one that rots.
 *
 * Why the check is structural rather than a regex over the file: nginx drops
 * every inherited `add_header` in a `location` that sets its own. A single
 * `add_header` added to one `location` for an unrelated reason silently removes
 * the HSTS and CSP headers from every response that location serves, and
 * nothing errors. So "at server level" has to be proven by where the directive
 * sits in the block tree, not by what it looks like.
 *
 * The app's own code is a possible second author too: a route handler or the
 * proxy can set a header on a response, and nginx's copy would then arrive
 * beside it. The evidence download route did exactly that for
 * X-Content-Type-Options. So no tracked source file under app/, lib/ or the
 * root proxy/middleware may name any of the six headers.
 *
 * What this cannot prove is that the browser accepts the policy on every page.
 * That is `e2e/csp.spec.ts`, which needs a running app and so runs in CI only.
 */

/** The M0 policy, verbatim. A change to it is a security decision, so it is
 * pinned here as a literal and not derived from the file under test. */
const M0_CSP =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; " +
  "base-uri 'self'; form-action 'self'; frame-ancestors 'none'";

const SECURITY_HEADERS = [
  'Strict-Transport-Security',
  'Content-Security-Policy',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy',
  'Permissions-Policy',
] as const;

type Node = { name: string; args: string[]; children?: Node[] };

/**
 * A just-enough nginx parser: directives end in `;`, blocks open with `{`,
 * `#` starts a comment, and a quote pairs only with its own kind (so the
 * single quotes inside the double-quoted CSP are literal, and the `;` inside
 * it does not end the directive).
 */
function parseNginx(source: string): Node[] {
  let pos = 0;

  function parseBlock(): Node[] {
    const nodes: Node[] = [];
    let words: string[] = [];
    let word = '';
    let inWord = false;

    const endWord = () => {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
    };

    while (pos < source.length) {
      const ch = source[pos];

      if (ch === '#') {
        while (pos < source.length && source[pos] !== '\n') pos++;
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        pos++;
        inWord = true;
        while (pos < source.length && source[pos] !== quote) word += source[pos++];
        pos++; // closing quote
        continue;
      }
      if (ch === ';') {
        pos++;
        endWord();
        if (words.length > 0) nodes.push({ name: words[0], args: words.slice(1) });
        words = [];
        continue;
      }
      if (ch === '{') {
        pos++;
        endWord();
        const children = parseBlock();
        nodes.push({ name: words[0] ?? '', args: words.slice(1), children });
        words = [];
        continue;
      }
      if (ch === '}') {
        pos++;
        return nodes;
      }
      if (/\s/.test(ch)) {
        endWord();
        pos++;
        continue;
      }
      word += ch;
      inWord = true;
      pos++;
    }
    return nodes;
  }

  return parseBlock();
}

/** Every directive in the tree, each with the chain of blocks it sits inside. */
function flatten(nodes: Node[], ancestors: Node[] = []): { node: Node; ancestors: Node[] }[] {
  return nodes.flatMap((node) => [
    ...(node.children ? [] : [{ node, ancestors }]),
    ...(node.children ? flatten(node.children, [...ancestors, node]) : []),
  ]);
}

const conf = parseNginx(readFileSync('docker/nginx/default.conf', 'utf8'));
const directives = flatten(conf);

function addHeaders(name: string) {
  return directives.filter(
    ({ node }) => node.name === 'add_header' && node.args[0]?.toLowerCase() === name.toLowerCase(),
  );
}

/** The HTTPS server: the one that terminates TLS and proxies to the app. The
 * port-80 server only redirects and has no headers to carry. */
function httpsServer(): Node {
  const found = conf
    .flatMap(function find(n: Node): Node[] {
      return [n, ...(n.children ?? []).flatMap(find)];
    })
    .find(
      (n) =>
        n.name === 'server' &&
        (n.children ?? []).some((d) => d.name === 'listen' && d.args[0]?.startsWith('443')),
    );
  if (!found) throw new Error('docker/nginx/default.conf has no `server` listening on 443');
  return found;
}

/** next.config.ts with comments removed, so the file may explain why it sets
 * no headers without tripping the check that it sets none. */
function nextConfigSource(): string {
  return readFileSync('next.config.ts', 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Tracked app code that could put a header on a response. */
function appSourceFiles(): string[] {
  return execFileSync('git', ['ls-files', 'app', 'lib', 'middleware.ts', 'proxy.ts'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => /\.tsx?$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f));
}

describe('security headers have a single source', () => {
  it('CSP is exactly the M0 policy', () => {
    const csp = addHeaders('Content-Security-Policy');
    expect(csp, 'expected exactly one Content-Security-Policy add_header').toHaveLength(1);
    expect(csp[0].node.args[1]).toBe(M0_CSP);

    // The exact-match above already excludes it; this names the property so a
    // failure reads as what it is rather than as a string diff.
    const everyArg = directives.flatMap(({ node }) => node.args).join(' ');
    expect(everyArg, "'unsafe-eval' must appear nowhere in the nginx config").not.toContain(
      'unsafe-eval',
    );
  });

  it('each security header has one source, with always, at server level', () => {
    const server = httpsServer();

    for (const name of SECURITY_HEADERS) {
      const found = addHeaders(name);
      expect(found, `${name} must be set exactly once in default.conf`).toHaveLength(1);

      const { node, ancestors } = found[0];
      expect(node.args.at(-1), `${name} must end in "always", or nginx omits it on 4xx/5xx`).toBe(
        'always',
      );
      expect(
        ancestors.length === 1 && ancestors[0] === server,
        `${name} must sit directly in the HTTPS server block, not inside a nested block`,
      ).toBe(true);
    }

    // nginx drops every inherited add_header in a location that sets its own,
    // so one in ANY location (security header or not) strips the six above.
    const inLocation = directives.filter(
      ({ node, ancestors }) =>
        node.name === 'add_header' && ancestors.some((a) => a.name === 'location'),
    );
    expect(
      inLocation.map(({ node }) => node.args[0]),
      'no location block may contain add_header',
    ).toEqual([]);

    // Neither may the app: next.config.ts, nor any source file that can set a
    // response header (route handlers, server components, the proxy). Test
    // files are excluded; they assert on headers, they do not send them.
    const authors = appSourceFiles().filter((file) => {
      const text = readFileSync(file, 'utf8').toLowerCase();
      return SECURITY_HEADERS.some((name) => text.includes(name.toLowerCase()));
    });
    expect(authors, 'these app source files name a security header; nginx is the only source').toEqual(
      [],
    );

    const nextConfig = nextConfigSource();
    expect(nextConfig, 'next.config.ts must not define headers()').not.toMatch(/\bheaders\s*[(:]/);
    for (const name of SECURITY_HEADERS) {
      expect(nextConfig.toLowerCase(), `${name} must not appear in next.config.ts`).not.toContain(
        name.toLowerCase(),
      );
    }
  });

  it('hides server versions', () => {
    // At http context (top level of this file, outside both server blocks) so the
    // port-80 redirect is covered too, and nothing nested turns it back on.
    const topLevel = conf.find((d) => d.name === 'server_tokens');
    expect(topLevel?.args, '`server_tokens off;` must sit at the top level of default.conf').toEqual([
      'off',
    ]);
    const overrides = directives.filter(
      ({ node, ancestors }) => node.name === 'server_tokens' && ancestors.length > 0,
    );
    expect(overrides, 'no server or location block may override server_tokens').toEqual([]);

    expect(nextConfigSource(), 'next.config.ts must set poweredByHeader: false').toMatch(
      /\bpoweredByHeader\s*:\s*false\b/,
    );
  });
});
