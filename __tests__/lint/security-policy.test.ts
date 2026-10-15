import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SECURITY.md says what a reporter may test and where to send it. Until Task 19 it said the
 * opposite of the truth about the host: "nothing is deployed", "no users and no deployment",
 * "Hosted infrastructure -- none exists to test". The production host IS live, so a reporter
 * who read that would conclude there was nothing to report against, or, worse, would not know
 * which hostname the project answers for.
 *
 * Markdown wraps its lines, so every phrase is matched on the text with its whitespace
 * collapsed. The release-process wording Task 18 added is pinned too, so rewriting the scope
 * cannot quietly drop it.
 */

const REPO_ROOT = join(__dirname, '../..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');
const flat = (s: string) => s.replace(/\s+/g, ' ');

const policy = flat(read('SECURITY.md'));

/** The text from heading `from` up to heading `to` (exclusive). */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect(start, `SECURITY.md should still contain ${JSON.stringify(from)}`).toBeGreaterThan(-1);
  const end = text.indexOf(to, start + from.length);
  expect(end, `SECURITY.md should still contain ${JSON.stringify(to)} after ${JSON.stringify(from)}`).toBeGreaterThan(start);
  return text.slice(start, end);
}

describe('SECURITY.md describes a host that is live', () => {
  it.each([
    'nothing is deployed',
    'no deployment',
    'no users and no',
    'none exists to test',
    'purchased but unconfigured',
    'never served a request',
  ])('no longer says %j', (phrase) => {
    expect(policy.toLowerCase()).not.toContain(phrase);
  });

  it('puts makrai.org and its API in scope, for reports to the role address', () => {
    const inScope = between(policy, '**In scope**', '**Out of scope:**');
    expect(inScope).toContain('https://makrai.org');
    expect(inScope).toMatch(/\bAPI\b/);
    expect(inScope).toContain('security@makrai.org');
    expect(inScope.toLowerCase()).toContain('good faith');
  });

  it('keeps denial of service and other users’ data out of what a good-faith report may do', () => {
    const scope = between(policy, '## Scope', '## Supported versions');
    expect(scope).toMatch(/denial[- ]of[- ]service/i);
    expect(scope).toMatch(/(another|other) users?(’|')?s? data/i);
  });

  it('tells reporters to follow security.txt', () => {
    const scope = between(policy, '## Scope', '## Supported versions');
    expect(scope).toContain('https://makrai.org/.well-known/security.txt');
  });

  it('sends reports to the role address security.txt names, and to no personal address (G2-10)', () => {
    const route = between(policy, '## Reporting a vulnerability', '## Check what is already known first');
    expect(route).toContain('security@makrai.org');
    expect(policy).not.toMatch(/@(gmail|googlemail|outlook|hotmail|yahoo)\./i);
    const contact = /^Contact:\s*mailto:(\S+)\s*$/im.exec(read('public/.well-known/security.txt'));
    expect(contact, 'security.txt has a Contact').not.toBeNull();
    expect(route).toContain(contact![1]);
  });

  it('still names no host as in scope other than makrai.org and still excludes the legacy single-page app', () => {
    const out = between(policy, '**Out of scope:**', '## Supported versions');
    expect(out).toContain('makrai.netlify.app');
    expect(out.toLowerCase()).toContain('third-party dependencies');
  });
});

describe('SECURITY.md keeps the release-process wording', () => {
  it('says a release is a tag on main that equals package.json, built by release.yml, run by digest', () => {
    const supported = between(policy, '## Supported versions', '## Security model');
    expect(supported).toContain('`vX.Y.Z`');
    expect(supported).toContain('`package.json`');
    expect(supported).toContain('`.github/workflows/release.yml`');
    expect(supported).toContain('by digest');
    expect(supported).toContain('`docs/runbooks/deployment.md`');
    expect(supported).toMatch(/Only the \*\*latest release\*\* and the current state of \*\*`main`\*\* are supported/);
  });
});
