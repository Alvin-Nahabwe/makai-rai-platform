import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The v0.6.0 release paperwork: the personal-data map entry that register row D-264 names, and (Task 4) the release notes.
 */

describe('the v0.6.0 release', () => {
  it('NFR-PRIV-01 D-264: the personal-data map names request_receipts.requestDigest, with the 5.8 row of the email it digests', () => {
    const list = JSON.parse(readFileSync('__tests__/lint/personal-data-allowlist.json', 'utf8')) as Array<{ table: string; column: string; maps: string }>;
    const row = (table: string, column: string) => list.filter((e) => e.table === table && e.column === column).map((e) => e.maps);
    expect(row('invitations', 'email')).toHaveLength(1); // the email the digest holds
    expect(row('request_receipts', 'requestDigest')).toEqual(row('invitations', 'email'));
    expect(row('request_receipts', 'requestDigest')).not.toContain('no personal data');
  });
});
