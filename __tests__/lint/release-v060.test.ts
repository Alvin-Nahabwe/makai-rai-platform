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

  it('NFR-SEC-14 NFR-SEC-17 NFR-PRIV-05 FR-OPS-03: the v0.6.0 release notes carry the release facts and no value', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe('0.6.0');
    expect(t).toMatch(/^Checked release commit: [0-9a-f]{40}$/m);
    expect(t).toContain('The owner tags the merge commit of this pull request into main, not the checked release commit.');
    expect(t).toMatch(/^Live run: docs\/releases\/v0\.6\.0-live-run\.md \(candidate [0-9a-f]{40}\)$/m);
    for (const k of ['REMINDER_JOB_TOKEN', 'HC_REMINDER_PING_URL', 'SYNTHETIC_PROJECT_ID', 'SYNTHETIC_STAGE', 'SYNTHETIC_QUESTION_ID']) expect(t).toContain(`\`${k}\``);
    for (const k of ['ALLOW_OPEN_REGISTRATION', 'ORG_LIMIT_PER_USER', 'SYNTHETIC_ASSESSMENT_ID']) expect(t).toContain(`\`${k}\``);
    expect(t).toContain('`REMINDER_JOB_TOKEN`: a new host secret, 64 lowercase hex characters the owner makes on the host with `openssl rand -hex 32` (8.5 step 4b)');
    expect(t).toContain("`HC_REMINDER_PING_URL`: the reminder job's dead-man check, created by the owner (8.5 step 4a)");
    expect(t).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}=\S/); // no KEY=value anywhere
    expect(t).toContain("Every production step is the owner's; no step runs in an AI session on the production host (deployment.md 8.5, 12.2).");
    expect(t).toMatch(/^Secret scan, repository: no leaks found/m);
    expect(t).toMatch(/^Secret scan, build output: no \.env files/m);
    expect(t).toMatch(/^Secret scan, image: (no leaks found|not run, no image)/m);
  });

  it('NFR-MNT-02: the notes record CI times within their limits', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    expect(Number(/^CI verify: (\d+) min$/m.exec(t)?.[1])).toBeLessThanOrEqual(15);
    expect(Number(/^CI test-e2e: (\d+) min$/m.exec(t)?.[1])).toBeLessThanOrEqual(30);
  });

  it('NFR-MNT-06: the notes list the ten ADRs and the register rows', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    for (const n of ['0011', '0012', '0013', '0014', '0015', '0016', '0017', '0018', '0019', '0020']) expect(t).toMatch(new RegExp(`\\]\\(\\.\\./adr/${n}-`));
    expect(t).toMatch(/^Register rows: (None|D-\d{3}(, D-\d{3})*)$/m);
  });
});
