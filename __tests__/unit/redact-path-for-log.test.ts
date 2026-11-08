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
  it('docker/nginx/default.conf still holds the same pattern in its $log_uri map', () => {
    const conf = readFileSync(join(__dirname, '../../docker/nginx/default.conf'), 'utf8');
    const block = /map \$uri \$log_uri \{([^}]*)\}/.exec(conf);
    expect(block).not.toBeNull();
    expect(block![1]).toContain('~^(?<p>/(api/v1/)?invitations/)[^/]+(?<r>.*)$ $p[token]$r;');
  });
});
