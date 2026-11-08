import { describe, it, expect } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * FR-PUB-03: every technical control links at least one free tool it applies.
 * The links are content work (content 5.0.0, C-RES); this test is the gate that
 * says they are there.
 *
 * It reads `data/content/index.json` and the running version's
 * `assessmentAreas.json` straight from disk, not through `lib/content/root.ts`,
 * which the vitest setup points at the fixture bundle. The paths use the
 * contract's literal prefix after `process.cwd()` (Content bundle, "Static read
 * paths"), so no copy of this read can carry a computed root into `app` or
 * `lib`. The check takes the content root as a parameter only so a temporary
 * directory can stand in for it.
 *
 * Until content 5.0.0 exists the check has nothing to read and passes, unless
 * `RELEASE_CANDIDATE=1`: a release candidate without content is not a candidate.
 */
type Resource = { type?: string; url?: string };
type Control = { id: string; type?: string; resources?: Resource[] };

const REAL_ROOT = join(process.cwd(), 'data', 'content');

/** The problems found in the running version of `contentRoot`; `null` when there is no content directory to read. */
function technicalControlProblems(contentRoot: string = REAL_ROOT): string[] | null {
  const index = join(contentRoot, 'index.json');
  if (!existsSync(index)) return null;
  const { running: semver } = JSON.parse(readFileSync(index, 'utf8')) as { running: string };
  const { controls } = JSON.parse(readFileSync(join(contentRoot, semver, 'assessmentAreas.json'), 'utf8')) as {
    controls: Control[];
  };
  const problems: string[] = [];
  const technical = controls.filter((c) => c.type === 'technical');
  // C-03 C-04 C-05 C-10 C-13 C-14 C-15 C-16 C-18 C-21 in data/assessmentAreas.json today.
  if (technical.length !== 10) problems.push(`expected 10 technical controls, found ${technical.length}`);
  for (const c of technical) {
    // A tool counts only with a link to it: an entry with no https address does not "link" anything.
    const linked = (r: Resource) => r.type === 'tool' && typeof r.url === 'string' && r.url.startsWith('https://');
    if (!(c.resources ?? []).some(linked)) problems.push(`${c.id} has no resource of type "tool" with an https link`);
  }
  // "40 resources today" (SRS line 1111): the links are kept, not replaced.
  const total = controls.flatMap((c) => c.resources ?? []).length;
  if (total < 40) problems.push(`expected at least 40 resources, found ${total}`);
  return problems;
}

/** A content directory with 10 technical controls, `toolsOn` of which carry a tool link, and enough other links to reach 40. */
function writeContent(root: string, toolsOn: number): void {
  mkdirSync(join(root, '9.9.9'), { recursive: true });
  writeFileSync(join(root, 'index.json'), JSON.stringify({ running: '9.9.9', versions: ['9.9.9'] }));
  const controls: Control[] = Array.from({ length: 10 }, (_, i) => ({
    id: `C-T${i}`,
    type: 'technical',
    resources: [{ type: 'framework' }, ...(i < toolsOn ? [{ type: 'tool', url: 'https://example.org/tool' }] : [])],
  }));
  for (let i = 0; i < 30; i++) controls.push({ id: `C-P${i}`, type: 'procedural', resources: [{ type: 'framework' }, { type: 'paper' }] });
  writeFileSync(join(root, '9.9.9', 'assessmentAreas.json'), JSON.stringify({ controls }));
}

describe('technical controls link a free tool', () => {
  it('FR-PUB-03: every technical control has at least one resource of type "tool"', () => {
    const problems = technicalControlProblems();
    if (problems === null) {
      // Content 5.0.0 arrives with C-TXT and CNT.
      expect(process.env.RELEASE_CANDIDATE, 'RELEASE_CANDIDATE=1 and no data/content/index.json').not.toBe('1');
      return;
    }
    expect(problems).toEqual([]);
  });

  it('FR-PUB-03: a content directory whose technical controls lack tools is refused, naming each control', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tools-'));
    try {
      writeContent(dir, 7);
      expect(technicalControlProblems(dir)).toEqual([
        'C-T7 has no resource of type "tool" with an https link',
        'C-T8 has no resource of type "tool" with an https link',
        'C-T9 has no resource of type "tool" with an https link',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-03: a tool entry without an https address does not count as a link', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tools-'));
    try {
      writeContent(dir, 10);
      const file = join(dir, '9.9.9', 'assessmentAreas.json');
      const areas = JSON.parse(readFileSync(file, 'utf8')) as { controls: Control[] };
      areas.controls[0].resources = [{ type: 'framework' }, { type: 'tool' }];
      areas.controls[1].resources = [{ type: 'framework' }, { type: 'tool', url: 'http://example.org/plain' }];
      writeFileSync(file, JSON.stringify(areas));
      expect(technicalControlProblems(dir)).toEqual([
        'C-T0 has no resource of type "tool" with an https link',
        'C-T1 has no resource of type "tool" with an https link',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-03: a content directory where all ten technical controls link a tool passes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tools-'));
    try {
      writeContent(dir, 10);
      expect(technicalControlProblems(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('FR-PUB-03: a missing content directory is reported as nothing to read, not as a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tools-'));
    try {
      expect(technicalControlProblems(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
