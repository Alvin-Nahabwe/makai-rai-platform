/**
 * The live-run report's own check (SRS 12.2; V Task 6 Step 3). It reads docs/releases/v0.6.0-live-run.md and holds it to
 * the shape the owner reads before tagging: one section per 12.2 step with a verdict, one candidate commit, and the
 * idle-dialog, RM-helper and idle-log lines. The list of data-claims-allowed markers with the allow-list id each wraps
 * is the generated docs/releases/claims-markers.md (scripts/release/claims-markers.mjs), held here to be current.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OUT, alId, claimMarkers, render } from '../../scripts/release/claims-markers.mjs';

const REPORT = 'docs/releases/v0.6.0-live-run.md';
const range = (a: number, b: number): number[] => Array.from({ length: b - a + 1 }, (_, i) => a + i);
function section(t: string, n: number): string {
  const start = t.indexOf(`## Step ${n}. `);
  if (start < 0) return '';
  const next = t.indexOf('\n## ', start + 1);
  return next < 0 ? t.slice(start) : t.slice(start, next);
}

describe('the v0.6.0 live-run report', () => {
  it('12.2 NFR-A11Y-07 NFR-AVL-02 NFR-PERF-02 NFR-REL-02: the live-run report has a verdict for every 12.2 step on one commit', () => {
    const t = readFileSync(REPORT, 'utf8');
    const heads = [...t.matchAll(/^## Step (\d+)\. /gm)].map((m) => Number(m[1]));
    expect(heads).toEqual(range(1, 15));
    const commits = new Set([...t.matchAll(/^Candidate: ([0-9a-f]{40})$/gm)].map((m) => m[1]));
    expect(commits.size).toBe(1);
    for (const n of range(1, 15)) {
      expect(section(t, n), `step ${n}`).toMatch(/^Verdict: (pass|fail|not verified: .+)$/m);
      expect(section(t, n).match(/^Verdict: /gm), `step ${n}: exactly one Verdict line`).toHaveLength(1);   // a second line could satisfy a 'fails step n' check
    }
    for (const id of ['NFR-A11Y-07', 'NFR-AVL-02', 'NFR-PERF-02', 'NFR-REL-02']) expect(t).toContain(id);
    expect(t).not.toMatch(/^Source: V-prog round/m);   // a round's row is never the evidence (V-S5)
  });

  // The list is generated, so a marker that moves or is added fails here until `node scripts/release/claims-markers.mjs`
  // is run and its output committed. The v0.6.0 record above keeps the rows of that release.
  it('FR-PUB-01: docs/releases/claims-markers.md is what scripts/release/claims-markers.mjs writes now, and every marker in it has an allow-list id', () => {
    const found = claimMarkers();
    expect(found.length, 'not vacuous').toBeGreaterThan(0);
    expect(readFileSync(OUT, 'utf8'), 'stale: run node scripts/release/claims-markers.mjs').toBe(render(found));
    expect(found.filter((m) => alId(m.reason) === undefined).map((m) => `${m.file}:${m.line} ${m.reason}`), 'a marker with no allow-list id').toEqual([]);
  });

  it('FR-PUB-01 (harness): a marker with no id is written NONE, and the rows are sorted by file then line', () => {
    const text = render([{ file: 'app/a.tsx', line: 9, reason: 'about-model-scores' }, { file: 'app/a.tsx', line: 10, reason: 'something-new' }]);
    expect(text).toContain('| app/a.tsx:9 | about-model-scores | FR-RM-01 |\n| app/a.tsx:10 | something-new | NONE |');
    const ordered = claimMarkers().map((m) => [m.file, m.line] as const);
    expect(ordered).toEqual([...ordered].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1])));
  });

  it('12.2 FR-PUB-01 FR-RM-01: alId gives each known reason its id, a leading AL-n counts, and an unknown reason has none', () => {
    expect(alId('not-an-approval-service')).toBe('AL-3');
    expect(alId('why-no-score')).toBeUndefined();                                // its heading and marker left About (CONSOLIDATED section 4)
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
