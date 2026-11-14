import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The v0.7.0 release notes held to their form and to the waiver file. The notes are
 * read as text: no case here can tell whether a test total or a review verdict in them is right. package.json's
 * version is not pinned here: the next release moves it, and the notes name their own version in a sentence instead.
 */

const NOTES = 'docs/releases/v0.7.0.md';
const read = () => readFileSync(NOTES, 'utf8');

/** The text of one `## ` section, from its heading to the next `## ` heading (or the end). */
function section(t: string, heading: string): string {
  const start = t.indexOf(`\n## ${heading}`);
  expect(start, `the section "${heading}"`).toBeGreaterThan(-1);
  const rest = t.slice(start + 1);
  const next = rest.indexOf('\n## ', 3);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the v0.7.0 release notes', () => {
  it('NFR-SEC-17 NFR-MNT-06: the header lines are in the forms the test reads, and no placeholder is left', () => {
    const t = read();
    expect(t.split('\n')[0]).toBe('# MAK-AI RAI Platform v0.7.0: release notes');
    expect(t).toContain('The version in `package.json` is `0.7.0`.');
    expect(t).toMatch(/^Checked release commit: [0-9a-f]{40}$/m);
    expect(t).toContain('The owner tags the merge commit of this pull request into main, not the checked release commit.');
    expect(t).toMatch(/^Rehearsal: .+$/m);
    expect(t.split("Every production step is the owner's; no step runs in an AI session on the production host (deployment.md 8, 12.2).").length - 1).toBe(1);
    // The CI line is filled in from the run, not left as the draft's marker.
    const ci = /^CI on the checked release commit: (.+)$/m.exec(t)?.[1];
    expect(ci, 'the CI line').toBeDefined();
    expect(t).not.toMatch(/\b(CI_LINE|RUN_PR|RUN_PUSH|E2E_PR|E2E_PUSH|TODO|TBD)\b/);
    // The draft's named blanks are UPPER-CASE words joined by hyphens (CHECKED-COMMIT, PR-NUMBER, ...); none is left.
    // The platform's own name, MAK-AI, is the one such word the notes may hold.
    const blanks = (t.match(/\b[A-Z0-9]{2,}(-[A-Z0-9]{2,})+\b/g) ?? []).filter((w) => /[A-Z]{2,}-[A-Z]{2,}/.test(w) && w !== 'MAK-AI');
    expect(blanks, 'a draft blank left in the notes').toEqual([]);
    expect('Checked release commit: CHECKED-COMMIT'.match(/\b[A-Z0-9]{2,}(-[A-Z0-9]{2,})+\b/g)).toEqual(['CHECKED-COMMIT']); // the check sees a blank
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-MNT-06: the waiver the notes name is the one the waiver file holds for 0.7.0', () => {
    const t = read();
    const file = JSON.parse(readFileSync('docs/releases/release-waivers.json', 'utf8')) as {
      waivers: Array<{ release: string; owner_words: string; register_row: string }>;
    };
    const mine = file.waivers.filter((w) => w.release === '0.7.0');
    expect(mine, 'exactly one waiver entry for release 0.7.0').toHaveLength(1);
    const waivers = section(t, 'Owner waivers');
    for (const w of mine) {
      expect(waivers).toContain(`"${w.owner_words}"`);
      expect(waivers).toContain(w.register_row);
    }
    expect(waivers).toMatch(/The walk has not been done/);
    // An earlier release's owner words are not quoted as in force. 0.6.1 was deferred in the same words as 0.7.0
    // ("Defer the walk"); those words are this release's own.
    const own = new Set(mine.map((w) => w.owner_words));
    for (const w of file.waivers.filter((x) => x.release !== '0.7.0' && !own.has(x.owner_words))) expect(waivers).not.toContain(`"${w.owner_words}"`);
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-PRIV-05: the notes carry no value, and say no key is added, removed or renamed', () => {
    const t = read();
    expect(t).toContain('No key is added, removed or renamed in this release');
    expect(t).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}=\S/); // no KEY=value anywhere
    expect(t).not.toMatch(/hc-ping\.com\/|\b[0-9a-f]{64}\b/); // no ping address and no 64-hex token or digest
  });

  it('NFR-SEC-17 NFR-MNT-06: the notes say there was no security review of the whole release, and that there is no migration', () => {
    const t = read();
    // The release changes sign-in, joining, findings, documents, review and seal, downloads and the administrator's
    // screens, and no one reviewed v0.6.2..<checked release commit> as one change: the notes say so plainly.
    expect(t).toMatch(/^- No security review was run for v0\.7\.0 as a whole: no independent reviewer read `v0\.6\.2\.\.[0-9a-f]{7,40}` as one change\./m);
    expect(t).not.toMatch(/^Security review: /m); // no line in the form of v0.6.1's, which had a review of the whole release
    expect(t).toMatch(/^There is no migration\./m);
    const deploy = section(t, 'Deploy and rollback');
    expect(deploy).toMatch(/There is no migration/);
    expect(deploy).toMatch(/PREV is v0\.6\.2/);
    expect(deploy).toMatch(/9\.3 does not apply/);
    for (const s of ['8.1', '8.2', '8.3', '8.4', '9.1', '9.2', '9.4']) expect(deploy, `runbook ${s} under Deploy and rollback`).toContain(s);
  });

  it('NFR-SEC-14 NFR-SEC-17: the scan lines exist, and Not verified names the host and the released images', () => {
    const t = read();
    expect(t).toMatch(/^Secret scan, repository: .+$/m);
    expect(t).toMatch(/^Secret scan, build output: .+$/m);
    expect(t).toMatch(/^Secret scan, image: .+$/m);
    const notVerified = section(t, 'Not verified');
    expect(notVerified).toMatch(/on the host/);
    expect(notVerified).toMatch(/released images of v0\.7\.0/);
    expect(notVerified).toMatch(/screen-reader walk/);
  });

  it('NFR-SEC-17 NFR-MNT-06: the owner steps are in order, with the merge method and a green image scan before the deploy', () => {
    const t = read();
    const next = section(t, 'What the owner does next');
    expect(next).toContain('with "Create a merge commit"');
    const at = (s: string) => next.indexOf(s);
    const order = [
      at('1. The owner reads these notes'),
      at('2. The owner merges the release pull request'),
      at('3. The tag gate is run on the merge commit'),
      at('4. The owner tags the merge commit `v0.7.0`'),
      at('5. The owner runs the image scan'),
      at('6. Then, at a time when no one is working on the platform'),
      at('7. If the post-check fails: 9.1, 9.2 and 9.4'),
    ];
    expect(order.every((i) => i > -1), 'all seven steps present').toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(next).toMatch(/It must be green before the deploy\./);
    expect(next).toContain('8.1 steps 2 to 4');
    expect(next).toContain('8.3 steps 1, 2, 3 and 5');
  });

  it('NFR-MNT-06: the Register rows line has the form v0.6.0 uses, and names the rows the notes cite', () => {
    const t = read();
    const line = /^Register rows: (None|D-\d{3}(, D-\d{3})*)$/m.exec(t);
    expect(line, 'the Register rows: line').not.toBeNull();
    const listed = new Set(line?.[0].match(/D-\d{3}/g));
    for (const cited of new Set(t.match(/\bD-\d{3}\b/g))) expect(listed.has(cited), `${cited} is cited but not in the Register rows line`).toBe(true);
  });
});
