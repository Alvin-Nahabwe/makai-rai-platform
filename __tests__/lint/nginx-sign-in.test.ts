import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Ruling 10 (SRS NFR-SEC-06; gap NF-1; obligation B6): nginx limited /api/auth/ per address (30 a minute, burst 5) and
 * /api/auth/register (10 a minute), which locks a department out after a few sign-ins from its one address. No
 * per-address limit stays, not even a flood ceiling (call R-49). The invitation-path masking of the access log stays
 * (NFR-OBS-01).
 */
describe('nginx keeps no sign-in limit', () => {
  it('NFR-SEC-06 FR-ACC-05: nginx keeps no limit_req zone or rule, and still masks invitation paths', () => {
    const conf = readFileSync('docker/nginx/default.conf', 'utf8');
    expect(conf).not.toMatch(/limit_req/);
    expect(conf).toMatch(/map \$uri \$log_uri/);
    expect(conf).not.toMatch(/location\s+(=\s*)?\/api\/auth/);
    expect(conf.match(/^\s*location \/ \{/gm)).toHaveLength(1);
  });
});
