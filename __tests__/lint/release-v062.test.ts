import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The v0.6.2 release notes held to their form, to the waiver file and to the compose file's nginx pin. The notes are
 * read as text: no case here can tell whether a test total or a rehearsal verdict in them is right. package.json's
 * version is not pinned here: the next release moves it, and the notes name their own version in a sentence instead.
 */

const NOTES = 'docs/releases/v0.6.2.md';
const read = () => readFileSync(NOTES, 'utf8');

/** The text of one `## ` section, from its heading to the next `## ` heading (or the end). */
function section(t: string, heading: string): string {
  const start = t.indexOf(`\n## ${heading}`);
  expect(start, `the section "${heading}"`).toBeGreaterThan(-1);
  const rest = t.slice(start + 1);
  const next = rest.indexOf('\n## ', 3);
  return next === -1 ? rest : rest.slice(0, next);
}

describe('the v0.6.2 release notes', () => {
  it('NFR-SEC-17 NFR-MNT-06: the header lines are in the forms the test reads, and no placeholder is left', () => {
    const t = read();
    expect(t.split('\n')[0]).toBe('# MAK-AI RAI Platform v0.6.2: release notes');
    expect(t).toContain('The version in `package.json` is `0.6.2`.');
    expect(t).toMatch(/^Checked release commit: [0-9a-f]{40}$/m);
    expect(t).toContain('The owner tags the merge commit of this pull request into main, not the checked release commit.');
    expect(t).toMatch(/^Rehearsal: .+$/m);
    expect(t.split("Every production step is the owner's; no step runs in an AI session on the production host (deployment.md 8.6, 12.2).").length - 1).toBe(1);
    // The CI line is filled in from the run, not left as the draft's marker.
    const ci = /^CI on the checked release commit: (.+)$/m.exec(t)?.[1];
    expect(ci, 'the CI line').toBeDefined();
    expect(t).not.toMatch(/\b(CI_LINE|RUN_PR|RUN_PUSH|E2E_PR|E2E_PUSH|TODO|TBD)\b/);
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-MNT-06: the waiver the notes name is the one the waiver file holds for 0.6.2', () => {
    const t = read();
    const file = JSON.parse(readFileSync('docs/releases/release-waivers.json', 'utf8')) as {
      waivers: Array<{ release: string; owner_words: string; register_row: string }>;
    };
    const mine = file.waivers.filter((w) => w.release === '0.6.2');
    expect(mine, 'exactly one waiver entry for release 0.6.2').toHaveLength(1);
    const waivers = section(t, 'Owner waivers');
    for (const w of mine) {
      expect(waivers).toContain(`"${w.owner_words}"`);
      expect(waivers).toContain(w.register_row);
    }
    expect(waivers).toMatch(/The walk has not been done\./);
    // An earlier release's owner words are not quoted as in force.
    for (const w of file.waivers.filter((x) => x.release !== '0.6.2')) expect(waivers).not.toContain(`"${w.owner_words}"`);
  });

  it('NFR-SEC-14 NFR-SEC-17 NFR-PRIV-05: the notes carry no value, and say no key is added, removed or renamed', () => {
    const t = read();
    expect(t).toContain('No key is added, removed or renamed in this release');
    expect(t).not.toMatch(/\b[A-Z][A-Z0-9_]{3,}=\S/); // no KEY=value anywhere
    expect(t).not.toMatch(/hc-ping\.com\/|\b[0-9a-f]{64}\b/); // no ping address and no 64-hex token or digest
  });

  it('NFR-SEC-06 D-338 D-339: the nginx image the notes name is the one the compose file pins, and v0.6.1 is not a target', () => {
    const t = read();
    const compose = readFileSync('docker/docker-compose.prod.yml', 'utf8');
    const pins = [...compose.matchAll(/^\s*image:\s*nginx:\S*@sha256:([0-9a-f]{64})\s*$/gm)].map((m) => m[1]);
    expect(pins).toHaveLength(1);
    expect(t).toContain(`\`sha256:${pins[0].slice(0, 8)}\``); // the digest's first eight characters, as the notes write it
    expect(t).toMatch(/v0\.6\.1 was tagged on 12 November 2026 and was not deployed/);
    const deploy = section(t, 'Deploy and rollback');
    expect(deploy).toMatch(/Deploy v0\.6\.2, never v0\.6\.1/);
    expect(deploy).toMatch(/returns to v0\.6\.0, never to v0\.6\.1/);
    expect(deploy).toMatch(/unfixed library/); // the rollback image is not presented as clean
    for (const s of ['8.6', '9.2', '9.4', '9.5a', '9.6']) expect(deploy, `runbook ${s} under Deploy and rollback`).toContain(s);
  });

  it('NFR-SEC-14 NFR-SEC-17: the scan lines say what was scanned and what was not repeated, and Not verified names the host and the released images', () => {
    const t = read();
    expect(t).toMatch(/^Secret scan, repository: no leaks found\. gitleaks v8\.30\.1 over `v0\.6\.1\.\.[0-9a-f]{40}` \(\d+ commits\)/m);
    expect(t).toMatch(/^Image scan, nginx: no finding\./m);
    expect(t).toMatch(/^Secret scan, image: not repeated\./m);
    expect(t).toMatch(/No security review was run for v0\.6\.2/);
    const notVerified = section(t, 'Not verified');
    expect(notVerified).toMatch(/on the host/);
    expect(notVerified).toMatch(/released images of v0\.6\.2/);
    expect(notVerified).toContain('docs/releases/v0.6.1.md');
  });

  it('NFR-SEC-17 NFR-MNT-06: the owner steps are in order, with the merge method and a green image scan before the deploy', () => {
    const t = read();
    const next = section(t, 'What the owner does next');
    expect(next).toContain('with "Create a merge commit"');
    const at = (s: string) => next.indexOf(s);
    const order = [
      at('1. The owner reads these notes'),
      at('2. The owner merges pull request 91'),
      at('3. The tag gate is run on the merge commit'),
      at('4. The owner tags the merge commit `v0.6.2`'),
      at('5. The owner runs the image scan'),
      at('6. Then, in the window the owner sets, runbook 8.6'),
    ];
    expect(order.every((i) => i > -1), 'all six steps present').toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(next).toMatch(/It must be green before the deploy\./);
    // The rule the release adds to the runbook is put to the owner, not only applied.
    expect(next.slice(0, at('2. The owner merges'))).toMatch(/the owner confirms it or changes it/);
  });

  it('NFR-MNT-06: the Register rows line has the form v0.6.0 uses, and names the rows the notes cite', () => {
    const t = read();
    const line = /^Register rows: (None|D-\d{3}(, D-\d{3})*)$/m.exec(t);
    expect(line, 'the Register rows: line').not.toBeNull();
    const listed = new Set(line?.[0].match(/D-\d{3}/g));
    for (const cited of new Set(t.match(/\bD-\d{3}\b/g))) expect(listed.has(cited), `${cited} is cited but not in the Register rows line`).toBe(true);
  });
});
