import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The v0.6.0 release paperwork: the personal-data map entry that register row D-264 names, and (Task 4) the release notes.
 */

// The ADR files at the last release, read with `git ls-tree -r --name-only d13be0c docs/adr` (d13be0c is the v0.5.1 release merge; there is
// no v0.5.1 tag). A constant, so the test needs no git history (CI clones at depth 1). The retired names are built from parts, so this
// file names neither (removed-settings.test.ts holds the rule).
const ADRS_AT_LAST_RELEASE = new Set([
  '0001-data-access-architecture.md',
  '0002-identity-and-account-linking.md',
  '0003-framework-version-registry-third-lane.md',
  '0004-eight-principles-from-unesco-ten.md',
  '0009-identity-lane-role.md',
  '0010-break-glass-and-integrity-log.md',
]);
const RETIRED = [['ALLOW', 'OPEN', 'REGISTRATION'].join('_'), ['ORG', 'LIMIT', 'PER', 'USER'].join('_')];
const KEYS = ['REMINDER_JOB_TOKEN', 'HC_REMINDER_PING_URL', 'SYNTHETIC_PROJECT_ID', 'SYNTHETIC_STAGE', 'SYNTHETIC_QUESTION_ID'];

describe('the v0.6.0 release', () => {
  it('NFR-PRIV-01 D-264: the personal-data map names request_receipts.requestDigest, with the 5.8 row of the email it digests', () => {
    const list = JSON.parse(readFileSync('__tests__/lint/personal-data-allowlist.json', 'utf8')) as Array<{ table: string; column: string; maps: string }>;
    const row = (table: string, column: string) => list.filter((e) => e.table === table && e.column === column).map((e) => e.maps);
    expect(row('invitations', 'email')).toHaveLength(1); // the email the digest holds
    expect(row('request_receipts', 'requestDigest')).toEqual(row('invitations', 'email'));
    expect(row('request_receipts', 'requestDigest')).not.toContain('no personal data');
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-PRIV-05: the v0.6.0 release notes carry the release facts and no value', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    // The notes say which version they are for; package.json moves on with later releases.
    expect(t).toContain('The version in `package.json` is `0.6.0`.');
    expect(t).toMatch(/^Checked release commit: [0-9a-f]{40}$/m);
    expect(t).toContain('The owner tags the merge commit of this pull request into main, not the checked release commit.');
    const candidate = /^Candidate: ([0-9a-f]{40})$/m.exec(readFileSync('docs/releases/v0.6.0-live-run.md', 'utf8'))?.[1];
    expect(candidate, "the live-run report's own Candidate: line").toBeDefined();
    expect(t).toContain(`Live run: docs/releases/v0.6.0-live-run.md (candidate ${candidate})`);
    for (const k of [...KEYS, ...RETIRED, 'SYNTHETIC_ASSESSMENT_ID']) expect(t).toContain(`\`${k}\``);
    expect(t).toContain('`REMINDER_JOB_TOKEN`: a new host secret, 64 lowercase hex characters the owner makes on the host with `openssl rand -hex 32` (8.5 step 4b)');
    expect(t).toContain("`HC_REMINDER_PING_URL`: the reminder job's dead-man check, created by the owner (8.5 step 4a), and the owner writes it into the server `.env` in step 8");
    expect(t).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}=\S/); // no KEY=value anywhere
    // nor any of the five keys with a value after = or :, bare, quoted or inside backticks (`KEY`: value). Words of prose are shorter than a value.
    expect(t).not.toMatch(new RegExp(`\\b(${KEYS.join('|')})\\b[\`"']?\\s*[=:]\\s*[\`"']?[A-Za-z0-9+/_-]{20,}`, 'i'));
    expect('`REMINDER_JOB_TOKEN`: abcdefghijklmnopqrstuvwxyz').toMatch(new RegExp(`\\b(${KEYS.join('|')})\\b[\`"']?\\s*[=:]\\s*[\`"']?[A-Za-z0-9+/_-]{20,}`, 'i')); // the check catches the backticked shape
    expect(t).not.toMatch(/hc-ping\.com\/|\b[0-9a-f]{64}\b/); // no ping address and no 64-hex token
    expect(t).toContain("Every production step is the owner's; no step runs in an AI session on the production host (deployment.md 8.5, 12.2).");
    expect(t).toMatch(/^Secret scan, repository: no leaks found\. gitleaks v8\.30\.1 over `v0\.5\.0\.\.[0-9a-f]{40}` \(\d+ commits\)/m);
    expect(t).toMatch(/^Secret scan, migrator image: no leaks found/m);
    expect(t).toMatch(/^Secret scan, build output: no \.env files/m);
    expect(t).toMatch(/^Secret scan, image: (no leaks found|not run, no image)/m);
  });

  it('NFR-SEC-17 NFR-MNT-06: the hand-over names the merge method, the open deploy window, the pre-deploy steps and the gate', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    expect(t).toContain('merges it with Create a merge commit');
    expect(t).toContain("The deploy window is the owner's to set (owner question A6 is open); runbook 8.5's 'Monday 2 November' heading is out of date.");
    expect(t).not.toMatch(/Mon 2 Nov|Tue 3 Nov/);
    for (const step of ['1', '2', '3', '4', '4a', '4b', '4c', '4d']) expect(t, `8.5 step ${step} before the deploy day`).toMatch(new RegExp(`8\\.5 step ${step}\\b`));
    expect(t).toContain('a count above zero stops the deploy');
    expect(t).toContain('Trivy step reports CRITICAL-rated secrets only');
    expect(t).toContain('any output other than `0|0|0` then `1`');
    // Runbook 8.5's order: the read-only counts (step 2, the go or no-go gate) come before the merge and the tag (step 4f, deploy day by 14:00).
    const gate = t.indexOf('8.5 step 2:');
    expect(gate, 'the step 2 line').toBeGreaterThan(-1);
    expect(t.indexOf('8.5 step 4f')).toBeGreaterThan(gate);
    expect(t).toContain('by 14:00');
    expect(t.indexOf('merges it with Create a merge commit')).toBeGreaterThan(gate);
    expect(t.indexOf('tags the merge commit `v0.6.0`')).toBeGreaterThan(gate);
  });

  it('NFR-SEC-17 NFR-MNT-02: the notes cite the run records by full path, say the migrator result rests on both fingerprint sets, and list what is queued for 0.6.1', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    expect(t).toContain("the controller's run records, kept on the build machine (not in this repository)");
    expect(t).toContain('records/plans/2026-10-29-v1-plan/run/sec-report.md');
    expect(t).toContain('records/plans/2026-10-29-v1-plan/run/fix3-security-review.md');
    expect(t).not.toMatch(/in the records repository/);
    expect(t).toMatch(/nineteen findings: thirteen triaged for the migrator, and six/);
    const known = t.slice(t.indexOf('## Known for 0.6.1'));
    expect(known).toMatch(/Trivy/);
    expect(known).toMatch(/migrator image/);
    expect(t).not.toMatch(/30-minute limit/);
  });

  it('NFR-MNT-02: the notes record CI times within their limits', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    expect(Number(/^CI verify: (\d+) min$/m.exec(t)?.[1])).toBeLessThanOrEqual(15);
    expect(Number(/^CI test-e2e: (\d+) min$/m.exec(t)?.[1])).toBeLessThanOrEqual(30);
  });

  it('NFR-MNT-06: the notes list every ADR this release adds, and the register rows', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    const added = readdirSync('docs/adr').filter((f) => /^\d{4}-.*\.md$/.test(f) && !ADRS_AT_LAST_RELEASE.has(f));
    expect(added.length, 'the release adds ADRs 0011 to 0021').toBeGreaterThanOrEqual(11);
    for (const f of added) expect(t, f).toMatch(new RegExp(`\\]\\(\\.\\./adr/${f.slice(0, 5)}`));
    expect(t).toMatch(/^Register rows: (None|D-\d{3}(, D-\d{3})*)$/m);
  });
});
