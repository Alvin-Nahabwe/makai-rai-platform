import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Plan 1A Task 12 (L2-64, S9): every page under a project renders RememberProject, so the rail's Findings link follows the
 * project the person last opened, wherever in it they were. The directory is walked, so a new project page fails here
 * until it renders it too.
 */
const ROOT = 'app/(authenticated)/orgs/[slug]/projects/[id]';

function pages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return pages(p);
    return e.name === 'page.tsx' ? [p] : [];
  });
}

describe('RememberProject on every project page', () => {
  const files = pages(ROOT).sort();

  it('1A Task 12 L2-64: there are at least the twelve project pages of this task', () => {
    expect(files.length).toBeGreaterThanOrEqual(12);
  });

  it('1A Task 12 L2-64 S9: every page.tsx under projects/[id]/ renders <RememberProject with the person\'s id, the slug and the project id', () => {
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      expect(src, f).toMatch(/<RememberProject\b/);
      expect(src, f).toMatch(/import RememberProject from '@\/components\/layout\/RememberProject';/);
      for (const m of src.matchAll(/<RememberProject\b([^>]*)\/>/g)) {
        expect(m[1], f).toMatch(/\buserId=\{/);
        expect(m[1], f).toMatch(/\borgSlug=\{slug\}/);
        expect(m[1], f).toMatch(/\bprojectId=\{/);
      }
    }
  });

  it('1A Task 12 S9: the export page\'s refusal, rendered without reading the project, remembers nothing', () => {
    const src = readFileSync(join(ROOT, 'export/page.tsx'), 'utf8');
    const refused = /if \(loaded\.refused\)[^\n]*\n?[^\n]*return[^;]*;/.exec(src)?.[0] ?? '';
    expect(refused).not.toBe('');
    expect(refused).not.toMatch(/RememberProject/);
  });
});
