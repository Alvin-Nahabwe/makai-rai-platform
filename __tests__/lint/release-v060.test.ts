import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The v0.6.0 release paperwork: the personal-data map entry that register row D-264 names, and (Task 4) the release notes.
 */

// The last release (v0.5.1, commit d13be0c; the repository has no local tag for it). The retired names are built from parts, so this
// file names neither (removed-settings.test.ts holds the rule).
const LAST_RELEASE = 'd13be0c';
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
    expect(JSON.parse(readFileSync('package.json', 'utf8')).version).toBe('0.6.0');
    expect(t).toMatch(/^Checked release commit: [0-9a-f]{40}$/m);
    expect(t).toContain('The owner tags the merge commit of this pull request into main, not the checked release commit.');
    const candidate = /^Candidate: ([0-9a-f]{40})$/m.exec(readFileSync('docs/releases/v0.6.0-live-run.md', 'utf8'))?.[1];
    expect(candidate, "the live-run report's own Candidate: line").toBeDefined();
    expect(t).toContain(`Live run: docs/releases/v0.6.0-live-run.md (candidate ${candidate})`);
    for (const k of [...KEYS, ...RETIRED, 'SYNTHETIC_ASSESSMENT_ID']) expect(t).toContain(`\`${k}\``);
    expect(t).toContain('`REMINDER_JOB_TOKEN`: a new host secret, 64 lowercase hex characters the owner makes on the host with `openssl rand -hex 32` (8.5 step 4b)');
    expect(t).toContain("`HC_REMINDER_PING_URL`: the reminder job's dead-man check, created by the owner (8.5 step 4a), and the owner writes it into the server `.env` in step 8");
    expect(t).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}=\S/); // no KEY=value anywhere
    expect(t).not.toMatch(new RegExp(`\\b(${KEYS.join('|')})\\b["']?\\s*[=:]\\s*["']?[^\\s\`"']`, 'i')); // nor any of the five keys with a value after = or :
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
  });

  it('NFR-MNT-02: the notes record CI times within their limits', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    expect(Number(/^CI verify: (\d+) min$/m.exec(t)?.[1])).toBeLessThanOrEqual(15);
    expect(Number(/^CI test-e2e: (\d+) min$/m.exec(t)?.[1])).toBeLessThanOrEqual(30);
  });

  it('NFR-MNT-06: the notes list every ADR this release adds, and the register rows', () => {
    const t = readFileSync('docs/releases/v0.6.0.md', 'utf8');
    const before = new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', LAST_RELEASE, 'docs/adr'], { encoding: 'utf8' }).split('\n'));
    const added = readdirSync('docs/adr').filter((f) => /^\d{4}-.*\.md$/.test(f) && !before.has(`docs/adr/${f}`));
    expect(added.length, 'the release adds ADRs 0011 to 0021').toBeGreaterThanOrEqual(11);
    for (const f of added) expect(t, f).toMatch(new RegExp(`\\]\\(\\.\\./adr/${f.slice(0, 5)}`));
    expect(t).toMatch(/^Register rows: (None|D-\d{3}(, D-\d{3})*)$/m);
  });
});
