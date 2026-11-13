/**
 * The live-run report's own check (SRS 12.2; V Task 6 Step 3). It reads docs/releases/v0.6.0-live-run.md and holds it to
 * the shape the owner reads before tagging: one section per 12.2 step with a verdict, one candidate commit, and the
 * idle-dialog, RM-helper and idle-log lines. The list of data-claims-allowed markers with the allow-list id each wraps
 * is the generated docs/releases/claims-markers.md (scripts/release/claims-markers.mjs): its list is held to the tree on
 * every run, its exact bytes (line numbers included) only under RELEASE_CANDIDATE=1.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OUT, REPO, alId, claimMarkers, parse, render, sortMarkers } from '../../scripts/release/claims-markers.mjs';

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

  // Always on: the list (file, reason, id) must match the tree, so an added, removed or re-reasoned marker fails at once,
  // while an edit that only moves a marker's line does not. Byte for byte, line numbers included, under RELEASE_CANDIDATE=1.
  it('FR-PUB-01: docs/releases/claims-markers.md lists every data-claims-allowed marker in the tree, with its reason and allow-list id, and none lacks an id', () => {
    const found = claimMarkers();
    expect(found.length, 'not vacuous').toBeGreaterThan(0);
    const key = (file: string, reason: string, id: string) => `${file} | ${reason} | ${id}`;
    const listed = parse(readFileSync(join(REPO, OUT), 'utf8')).map((r) => key(r.file, r.reason, r.id)).sort();
    expect(listed, 'run node scripts/release/claims-markers.mjs').toEqual(found.map((m) => key(m.file, m.reason, alId(m.reason) ?? 'NONE')).sort());
    expect(found.filter((m) => alId(m.reason) === undefined).map((m) => `${m.file}:${m.line} ${m.reason}`), 'a marker with no allow-list id').toEqual([]);
  });

  it.skipIf(process.env.RELEASE_CANDIDATE !== '1')('FR-PUB-01 (release candidate): docs/releases/claims-markers.md is byte for byte what scripts/release/claims-markers.mjs writes now, line numbers included', () => {
    expect(readFileSync(join(REPO, OUT), 'utf8'), 'stale: run node scripts/release/claims-markers.mjs').toBe(render(claimMarkers()));
  });

  it('FR-PUB-01 (harness): a marker with no id is written NONE, and the table is read back strictly', () => {
    const text = render([{ file: 'app/a.tsx', line: 9, reason: 'about-model-scores' }, { file: 'app/a.tsx', line: 10, reason: 'something-new' }]);
    expect(text).toContain('| app/a.tsx:9 | about-model-scores | FR-RM-01 |\n| app/a.tsx:10 | something-new | NONE |');
    expect(parse(text)).toEqual([
      { file: 'app/a.tsx', line: 9, reason: 'about-model-scores', id: 'FR-RM-01' },
      { file: 'app/a.tsx', line: 10, reason: 'something-new', id: 'NONE' },
    ]);
    expect(() => parse(render([]))).toThrow(/no rows/);
    expect(() => parse(`${text}a line that is not a row\n`)).toThrow(/not a marker row/);
    expect(() => parse('# no table\n')).toThrow(/no marker table/);
  });

  it('FR-PUB-01 (harness): the scanner reads a split, spaced, single-quoted or expression value, skips comments, and refuses a non-literal or a "|"', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claims-markers-'));
    try {
      mkdirSync(join(dir, 'app'));
      writeFileSync(join(dir, 'app', 'a.tsx'), [
        'export const a = (<div>',
        '  <p',
        '    data-claims-allowed',
        '      =',
        '    "split-form">x</p>',
        "  <p data-claims-allowed = 'single-form'>x</p>",
        '  <p data-claims-allowed={"expression-form"}>x</p>',
        '  {/* <p data-claims-allowed="in-a-comment">x</p> */}',
        '</div>);',
        '// <p data-claims-allowed="line-comment">x</p>',
      ].join('\n'));
      expect(claimMarkers(dir, ['app'])).toEqual([
        { file: 'app/a.tsx', line: 3, reason: 'split-form' },
        { file: 'app/a.tsx', line: 6, reason: 'single-form' },
        { file: 'app/a.tsx', line: 7, reason: 'expression-form' },
      ]);
      writeFileSync(join(dir, 'app', 'a.tsx'), 'const r = "x";\nexport const a = <p data-claims-allowed={r}>x</p>;\n');
      expect(() => claimMarkers(dir, ['app'])).toThrow(/app\/a\.tsx:2: .*not a string literal/);
      writeFileSync(join(dir, 'app', 'a.tsx'), 'export const a = <p data-claims-allowed="a|b">x</p>;\n');
      expect(() => claimMarkers(dir, ['app'])).toThrow(/may not contain "\|"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-01 (harness): markers sort by file, then by line as a number', () => {
    const m = (file: string, line: number) => ({ file, line, reason: 'r' });
    expect(sortMarkers([m('components/b.tsx', 1), m('app/a.tsx', 10), m('lib/c.ts', 2), m('app/a.tsx', 9)]))
      .toEqual([m('app/a.tsx', 9), m('app/a.tsx', 10), m('components/b.tsx', 1), m('lib/c.ts', 2)]);
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
