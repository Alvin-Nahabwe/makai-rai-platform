import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ControlsPage from '@/app/(authenticated)/explore/controls/page';
import { runningContent } from '@/lib/content/loader';
import { GUIDANCE_COPY } from '@/lib/guidance/copy';
import { TERM_CONTROL } from '@/lib/vocabulary/terms';

// The page calls the gate first (security review 0.7.0, L-1); here it lets every render through.
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: vi.fn(async () => ({ userId: 'u-1' })) }));
vi.mock('@/lib/content/resources', async () => {
  const { RES } = await import('../helpers/suggestionsFixture');
  return { loadResources: () => RES };
});
/** The guard's grep patterns, one list for the real tree and for the scratch files that prove it catches each quoting style. */
const GUARD_PATTERNS = ['-e', '["\'`]/templates/', '-e', '["\'`]/notebooks/', '-e', 'notebooks/technical', '-e', 'NOTEBOOK_BASE_URL'];

describe('S-27, the controls page', () => {
  it('FR-SUG-04 FR-SUG-05 FR-SUG-06: S-27 lists every control with only released notebooks and passed templates', async () => {
    const html = renderToStaticMarkup(await ControlsPage());
    const c = runningContent();
    for (const k of c.controls.values()) expect(html).toContain(`id="${k.id}"`);
    expect(html).toContain('/notebooks/C-13_subgroup-fairness.ipynb');
    expect(html).not.toContain('C-21_monitoring-drift');
    expect(html).not.toMatch(/github\.com\/Alvin-Nahabwe|coming soon/i);
    expect(html).not.toContain('C-02_cost-benefit-impact');
    expect(html).toContain('/templates/C-01_alternatives-analysis.html');
  });

  it('UX-13 FR-SUG-04: one h2 per control type with its count, a card per control, and links to its risk areas', async () => {
    const html = renderToStaticMarkup(await ControlsPage());
    const c = runningContent();
    const n = (t: string) => [...c.controls.values()].filter((k) => k.type === t).length;
    expect(html).toContain('<h1>Controls</h1>');
    expect(html).toContain(GUIDANCE_COPY.controls.count(c.controls.size));
    for (const t of ['technical', 'procedural', 'informational'] as const) {
      const { label, line } = GUIDANCE_COPY.controls.types[t];
      expect(html).toMatch(new RegExp(`>${GUIDANCE_COPY.controls.section(label, n(t)).replace(/[()]/g, '\\$&')}</h2><p[^>]*>${line}</p>`));
    }
    expect(html.match(/<article class="ctl-card"/g)).toHaveLength(c.controls.size);
    expect(html).toContain('href="/explore/framework#area-card-PP-01"');
    expect(html).toContain(GUIDANCE_COPY.controls.riskAreas);
    expect(html).not.toContain('<button');
  });

  // CONSOLIDATED section 4 (D AB45-AB47, EX19): About's "Free toolkits" section is this page's introduction now.
  it("UX-13 UX-03: S-27 opens with the line that took over the About page's free toolkits section", async () => {
    const html = renderToStaticMarkup(await ControlsPage());
    const intro = GUIDANCE_COPY.controls.intro;
    expect(intro.startsWith(`${TERM_CONTROL.definition} `)).toBe(true);
    expect(html).not.toMatch(/practice that lowers a risk|links to free guidance/);
    expect(html).toMatch(new RegExp(`<h1>Controls</h1><p[^>]*>${intro.replace(/\./g, '\\.')}</p>`));
    expect(html.indexOf(intro)).toBeLessThan(html.indexOf('<h2'));
  });

  it('FR-SUG-04: no file under app, components or lib links a template or notebook path except through the resources file', () => {
    // A quote or backtick before /templates/ or /notebooks/ keeps the e-mail templates (@/lib/email/templates/...) out of the match:
    // they are not a served file. grep exits 0 for a match and 1 for none; anything else (2) is a failed search, not a clean tree.
    const r = spawnSync('grep', ['-rln', ...GUARD_PATTERNS, 'app', 'components', 'lib', '--include=*.ts', '--include=*.tsx'], { encoding: 'utf8' });
    expect([0, 1], r.stderr).toContain(r.status);
    expect(r.stdout.split('\n').filter((f) => f !== '' && f !== 'lib/content/resources.ts')).toEqual([]);
  });

  it('FR-SUG-04: the guard catches a hard-coded link in each quoting style (checked on scratch files)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guard-'));
    try {
      mkdirSync(join(dir, 'components'));
      writeFileSync(join(dir, 'components/A.tsx'), 'const a = `/templates/${id}.html`;');
      writeFileSync(join(dir, 'components/B.tsx'), 'const b = "/notebooks/C-13_x.ipynb";');
      writeFileSync(join(dir, 'components/C.tsx'), "const c = '/templates/C-01.html';");
      writeFileSync(join(dir, 'components/D.tsx'), "import x from '@/lib/email/templates/accountCreated';");
      const r = spawnSync('grep', ['-rln', ...GUARD_PATTERNS, 'components'], { cwd: dir, encoding: 'utf8' });
      expect(r.stdout.split('\n').filter(Boolean).sort()).toEqual(['components/A.tsx', 'components/B.tsx', 'components/C.tsx']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
