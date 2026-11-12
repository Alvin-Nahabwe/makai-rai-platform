import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The v0.6.1 release notes held to their form, and to the waiver file. The notes are read as text: no case here can tell
 * whether a number, a pull request or a rehearsal verdict in them is right. package.json's version is not pinned here:
 * the next release moves it, and the notes name their own version in a sentence instead.
 */

const NOTES = 'docs/releases/v0.6.1.md';
const read = () => readFileSync(NOTES, 'utf8');

/** The text of one `## ` section, from its heading to the next `## ` heading (or the end). */
function section(t: string, heading: string): string {
  const start = t.indexOf(`\n## ${heading}`);
  expect(start, `the section "${heading}"`).toBeGreaterThan(-1);
  const rest = t.slice(start + 1);
  const next = rest.indexOf('\n## ', 3);
  return next === -1 ? rest : rest.slice(0, next);
}

// The five keys v0.6.0 added to the server .env. v0.6.1 adds none; none may appear with a value.
const KEYS = ['REMINDER_JOB_TOKEN', 'HC_REMINDER_PING_URL', 'SYNTHETIC_PROJECT_ID', 'SYNTHETIC_STAGE', 'SYNTHETIC_QUESTION_ID'];

describe('the v0.6.1 release notes', () => {
  it('NFR-SEC-17 NFR-MNT-06: the header lines are in the forms the test reads, and the commits are full hashes', () => {
    const t = read();
    expect(t.split('\n')[0]).toBe('# MAK-AI RAI Platform v0.6.1: release notes');
    expect(t).toContain('The version in `package.json` is `0.6.1`.');
    const checked = /^Checked release commit: ([0-9a-f]{40})$/m.exec(t)?.[1];
    expect(checked, 'the Checked release commit: line').toBeDefined();
    expect(t).toContain('The owner tags the merge commit of this pull request into main, not the checked release commit.');
    const rehearsal = /^Rehearsal: (.+)$/m.exec(t)?.[1];
    expect(rehearsal, 'the Rehearsal: line').toBeDefined();
    const named = /\b[0-9a-f]{40}\b/.exec(rehearsal ?? '')?.[0];
    expect(named, 'the Rehearsal: line names a 40-hex candidate').toBeDefined();
    expect(named).toBe(checked); // the rehearsal ran on the checked release commit
    expect(t.split("Every production step is the owner's; no step runs in an AI session on the production host (deployment.md 8.6, 12.2).").length - 1).toBe(1);
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-MNT-06: the waiver the notes name is the one the waiver file holds for 0.6.1, and the old two are not renewed', () => {
    const t = read();
    const file = JSON.parse(readFileSync('docs/releases/release-waivers.json', 'utf8')) as {
      waivers: Array<{ release: string; owner_words: string; register_row: string }>;
    };
    const mine = file.waivers.filter((w) => w.release === '0.6.1');
    expect(mine, 'exactly one waiver entry for release 0.6.1').toHaveLength(1);
    const waivers = section(t, 'Owner waivers');
    for (const w of mine) {
      expect(waivers).toContain(`"${w.owner_words}"`);
      expect(waivers).toContain(w.register_row);
    }
    expect(waivers).toMatch(/D-293[^.]*not renewed/);
    expect(waivers).toMatch(/D-294[^.]*not renewed/);
    // Nothing in the notes asks the owner for a waiver the file does not hold: the 0.6.0 owner words are not quoted as in force.
    for (const w of file.waivers.filter((x) => x.release !== '0.6.1')) expect(waivers).not.toContain(`"${w.owner_words}"`);
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-PRIV-05: the notes carry no value, and say no key is added, removed or renamed', () => {
    const t = read();
    expect(t).toContain('No key is added, removed or renamed in this release.');
    expect(t).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}=\S/); // no KEY=value anywhere
    const afterKey = new RegExp(`\\b(${KEYS.join('|')})\\b[\`"']?\\s*[=:]\\s*[\`"']?[A-Za-z0-9+/_-]{20,}`, 'i');
    expect(t).not.toMatch(afterKey); // no long token after a key, bare, quoted or in backticks
    expect('`REMINDER_JOB_TOKEN`: abcdefghijklmnopqrstuvwxyz').toMatch(afterKey); // the check catches the backticked shape
    expect(t).not.toMatch(/hc-ping\.com\/|\b[0-9a-f]{64}\b/); // no ping address and no 64-hex token or digest
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-PRIV-05: the four secret-scan lines exist and say what was found', () => {
    const t = read();
    expect(t).toMatch(/^Secret scan, repository: no leaks found\. gitleaks v8\.30\.1 over `v0\.6\.0\.\.[0-9a-f]{40}` \(\d+ commits/m);
    expect(t).toMatch(/^Secret scan, build output: no \.env files/m);
    expect(t).toMatch(/^Secret scan, image: no leaks found/m);
    expect(t).toMatch(/^Secret scan, migrator image: no leaks found/m);
    // The security review's line states its counts and what it was not: a count with no limits reads as more than it is.
    const review = /^Security review: (.+)$/m.exec(t)?.[1];
    expect(review, 'the Security review: line').toBeDefined();
    expect(review).toMatch(/no Critical, High, Medium or Low finding|\d+ Critical/);
    expect(review).toMatch(/not a live test/);
    expect(review).toMatch(/not inspected/);
  });

  it('NFR-MNT-02: the CI times read as whole minutes, and a figure over a limit is carried to the next release', () => {
    const t = read();
    const verify = /^CI verify: (\d+) min and (\d+) min$/m.exec(t);
    const e2e = /^CI test-e2e: (\d+) min and (\d+) min$/m.exec(t);
    expect(verify, 'the CI verify: line').not.toBeNull();
    expect(e2e, 'the CI test-e2e: line').not.toBeNull();
    const v = [Number(verify?.[1]), Number(verify?.[2])];
    const e = [Number(e2e?.[1]), Number(e2e?.[2])];
    // NFR-MNT-02's figures: verify 15, e2e 30. A time above one is named in the list for the next release.
    const known = section(t, 'Known for the next release');
    if (e.some((m) => m > 30)) expect(known).toMatch(/e2e job/i);
    if (v.some((m) => m > 15)) expect(known).toMatch(/verify/i);
  });

  it('NFR-SEC-17 NFR-MNT-02: Not verified lists the nginx specs on the new nginx image with D-338, the incident names D-335, and the runbook sections are named', () => {
    const t = read();
    const notVerified = section(t, 'Not verified');
    expect(notVerified).toMatch(/nginx image/);
    expect(notVerified).toContain('D-338');
    expect(notVerified).toMatch(/screen-reader walk/);
    const incident = section(t, 'The incident in the rehearsal');
    expect(incident).toContain('D-335');
    expect(incident).toContain('answered "No need"');
    expect(incident).toMatch(/inferred/); // "no production data" is not stated as observed
    // The header line does not say the rehearsal stayed off the host without naming the incident.
    expect(/^Rehearsal: (.+)$/m.exec(t)?.[1]).toMatch(/incident/i);
    const deploy = section(t, 'Deploy and rollback');
    for (const s of ['8.6', '9.2', '9.4', '9.5a', '9.6']) expect(deploy, `runbook ${s} under Deploy and rollback`).toContain(s);
  });

  it('NFR-SEC-17 NFR-MNT-06: the owner steps follow the runbook order and the merge method', () => {
    const t = read();
    const next = section(t, 'What the owner does next');
    expect(next).toContain('with "Create a merge commit"');
    const at = (s: string) => next.indexOf(s);
    const order = [
      at('1. The owner reads these notes'),
      at('2. The owner merges pull request 90'),
      at('3. The tag gate is run on the merge commit'),
      at('4. The owner tags the merge commit `v0.6.1`'),
      at('5. The owner runs the image scan'),
      at('6. Then, in the window the owner sets, runbook 8.6'),
    ];
    expect(order.every((i) => i > -1), 'all six steps present').toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(next).toContain('8.1 steps 2 to 4');
    // Step 1 sends the owner to every runbook section this release changes for a deploy or a rollback.
    const first = next.slice(0, next.indexOf('2. The owner merges'));
    for (const s of ['8.1', '8.3', '8.4', '8.6', '9.3', '9.4', '9.5a', '9.6']) expect(first, `step 1 names ${s}`).toContain(s);
    for (const step of ['8.6 step 2', '8.6 step 3', '8.6 step 4', '8.6 step 5', '8.6 step 6']) expect(next).toContain(step);
  });

  it('NFR-MNT-06: the Register rows line has the form v0.6.0 uses, and names the rows the notes cite', () => {
    const t = read();
    const line = /^Register rows: (None|D-\d{3}(, D-\d{3})*)$/m.exec(t);
    expect(line, 'the Register rows: line').not.toBeNull();
    // Every D-nnn cited anywhere in the notes is on that line (the line is the list of what the notes touch).
    const listed = new Set(line?.[0].match(/D-\d{3}/g));
    for (const cited of new Set(t.match(/\bD-\d{3}\b/g))) {
      if (cited === 'D-293' || cited === 'D-294') continue; // named only as not renewed
      expect(listed.has(cited), `${cited} is cited but not in the Register rows line`).toBe(true);
    }
  });
});
