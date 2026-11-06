/**
 * The live-run report's own check (SRS 12.2; V Task 6 Step 3). It reads docs/releases/v0.6.0-live-run.md and holds it to
 * the shape the owner reads before tagging: one section per 12.2 step with a verdict, one candidate commit, every
 * data-claims-allowed marker listed with the allow-list id it wraps, and the idle-dialog, RM-helper and idle-log lines.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPORT = 'docs/releases/v0.6.0-live-run.md';
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function section(t: string, n: number): string {
  const start = t.indexOf(`## Step ${n}. `);
  if (start < 0) return '';
  const next = t.indexOf('\n## ', start + 1);
  return next < 0 ? t.slice(start) : t.slice(start, next);
}
/** A reason to the id of the allow-list entry it wraps, each read against SRS 7.5.3, or FR-RM-01's allow-list (SRS line 451). */
const AL_BY_REASON: Record<string, string> = { 'why-no-score': 'AL-5', 'not-an-approval-service': 'AL-3', 'about-model-scores': 'FR-RM-01' };
function alId(reason: string): string | undefined {
  return AL_BY_REASON[reason] ?? /^(AL-[1-8])\b/.exec(reason)?.[1];
}
function claimMarkers(): { at: string; reason: string }[] {
  const out: { at: string; reason: string }[] = [];
  for (const root of ['app', 'components', 'lib']) {
    for (const file of readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(file)) continue;
      readFileSync(join(root, file), 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(/data-claims-allowed=(?:"([^"]*)"|\{([^}]*)\})/g)) out.push({ at: `${root}/${file}:${i + 1}`, reason: m[1] ?? m[2] });
      });
    }
  }
  return out;
}

describe('the v0.6.0 live-run report', () => {
  it('12.2 NFR-A11Y-07 NFR-AVL-02 NFR-PERF-02 NFR-REL-02: the live-run report has a verdict for every 12.2 step on one commit', () => {
    const t = readFileSync(REPORT, 'utf8');
    const heads = [...t.matchAll(/^## Step (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(heads).toEqual(range(1, 15));
    const commits = new Set([...t.matchAll(/^Candidate: ([0-9a-f]{40})$/gm)].map((m) => m[1]));
    expect(commits.size).toBe(1);
    for (const n of range(1, 15)) expect(section(t, n), `step ${n}`).toMatch(/^Verdict: (pass|fail|not verified: .+)$/m);
    for (const id of ['NFR-A11Y-07', 'NFR-AVL-02', 'NFR-PERF-02', 'NFR-REL-02']) expect(t).toContain(id);
    expect(t).not.toMatch(/^Source: V-prog round/m);   // a round's row is never the evidence (V-S5)
  });

  it('12.2 FR-PUB-01: every data-claims-allowed marker in app/, components/ and lib/ is listed in the report with its AL id (or FR id, for about-model-scores), and one with none fails step 5', () => {
    const found = claimMarkers();
    expect(found.length, 'not vacuous').toBeGreaterThan(0);
    const s = section(readFileSync(REPORT, 'utf8'), 5);
    for (const m of found) expect(s, m.at).toContain(`| ${m.at} | ${m.reason} | ${alId(m.reason) ?? 'NONE'} |`);
    if (found.some((m) => !alId(m.reason))) expect(s, 'a marker with no AL id').toMatch(/^Verdict: fail/m);
  });

  it('12.2 FR-PUB-01 FR-RM-01: alId gives each known reason its id, a leading AL-n counts, and an unknown reason has none', () => {
    expect(alId('why-no-score')).toBe('AL-5'); expect(alId('not-an-approval-service')).toBe('AL-3');
    expect(alId('about-model-scores')).toBe('FR-RM-01');                          // SRS line 451 allow-lists the About page's accuracy and confidence score sentences
    expect(alId('AL-1 document statement')).toBe('AL-1');                         // DOC-a's marker (components/documents/GenerateDocumentForm.tsx)
    expect(alId('AL-9 nothing')).toBeUndefined(); expect(alId('something-new')).toBeUndefined();
  });

  it('UX-43 12.2 step 4: the report records the idle dialog read from the served HTML of a signed-in page through nginx, with a positive whole number of seconds at most the limit', () => {
    const s = section(readFileSync(REPORT, 'utf8'), 4);
    const m = /^Idle dialog: data-seconds-left=(\d+) limit=(\d+) page=\/orgs\/[^/\s]+\/dashboard via https:\/\/makrai\.org$/m.exec(s);
    expect(m, 'the Idle dialog line').not.toBeNull();
    expect(Number(m![2])).toBe(43200);                                            // the image has no MAKRAI_TEST_IDLE_SECONDS (V-S2)
    expect(Number(m![1])).toBeGreaterThan(0); expect(Number(m![1])).toBeLessThanOrEqual(Number(m![2]));
    expect(s, 'the access line').toMatch(/^Idle dialog access: --connect-to makrai\.org:443:127\.0\.0\.1:8460$/m);   // R15-1
  });

  it('FR-RM-04 UX-06 UX-07 12.2 step 4: the report records the RM helpers\' result for S-08, S-10, S-11 and S-14, and a failure fails step 4', () => {
    const s = section(readFileSync(REPORT, 'utf8'), 4);
    const m = /^RM helpers: (S-08 S-10 S-11 S-14 pass|.+)$/m.exec(s);
    expect(m, 'the RM helpers line').not.toBeNull();
    if (m![1] !== 'S-08 S-10 S-11 S-14 pass') expect(s, 'a failing screen').toMatch(/^Verdict: fail/m);
  });

  it('UX-43 12.2 step 12: the report records the count of idle_deadline_unreadable log lines, and a count above 0 fails step 12', () => {
    const s = section(readFileSync(REPORT, 'utf8'), 12);
    const m = /^Idle log: idle_deadline_unreadable count=(\d+)$/m.exec(s);
    expect(m, 'the Idle log line').not.toBeNull();
    if (Number(m![1]) > 0) expect(s, 'a non-zero count').toMatch(/^Verdict: fail/m);
  });
});
