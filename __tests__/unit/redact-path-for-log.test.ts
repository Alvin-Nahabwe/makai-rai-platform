import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactPathForLog } from '../../lib/redact';

/**
 * NFR-OBS-01, NFR-PRIV-03 (FIX-16): an invitation link carries a bearer token in the path. A log line
 * names the route, never the token. The rule is nginx's `$log_uri` map (docker/nginx/default.conf).
 */
describe('redactPathForLog (NFR-OBS-01, NFR-PRIV-03)', () => {
  it.each([
    ['/invitations/abc', '/invitations/[token]'],
    ['/api/v1/invitations/abc', '/api/v1/invitations/[token]'],
    ['/api/v1/invitations/abc/register', '/api/v1/invitations/[token]/register'],
  ])('masks the token in %s', (input, expected) => {
    expect(redactPathForLog(input)).toBe(expected);
  });

  it.each([
    '/api/v1/orgs/acme/invitations/inv_123/resend',
    '/api/v1/orgs/acme/invitations/inv_123/revoke',
    '/api/users/me',
    '/',
    '/invitations',
    '/invitations/',
  ])('leaves %s unchanged', (input) => {
    expect(redactPathForLog(input)).toBe(input);
  });
});

describe('redactPathForLog agrees with nginx (NFR-OBS-01)', () => {
  const conf = readFileSync(join(__dirname, '../../docker/nginx/default.conf'), 'utf8');
  // The map's one rule line: `~<pattern> <replacement>;`. The pattern is valid JS (named groups included).
  const block = /map \$uri \$log_uri \{([^}]*)\}/.exec(conf);
  const rule = block ? /^\s*~(\S+)\s+(\S+);/m.exec(block[1]) : null;

  it('finds the $log_uri map and its rule in docker/nginx/default.conf', () => {
    expect(block).not.toBeNull();
    expect(rule).not.toBeNull();
  });

  const token = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'; // 64 hex, as lib/data/members.ts makes them
  const paths = [
    `/invitations/${token}`,
    `/api/v1/invitations/${token}`,
    `/api/v1/invitations/${token}/register`,
    `/api/v1/invitations/${token}/`,
    '/api/v1/orgs/s/invitations/i/resend',
    '/api/v1/orgs/s/invitations/i/revoke',
    '/api/users/me',
    '/',
    '/invitations',
  ];

  it.each(paths)('nginx rule and redactPathForLog give the same output for %s', (path) => {
    const re = new RegExp(rule![1]);
    const replacement = rule![2].replace('$p', '$<p>').replace('$r', '$<r>');
    const nginx = re.test(path) ? path.replace(re, replacement) : path;
    expect(redactPathForLog(path)).toBe(nginx);
  });
});
