import { execSync } from 'node:child_process';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ControlsPage from '@/app/(authenticated)/explore/controls/page';
import { runningContent } from '@/lib/content/loader';

vi.mock('@/lib/content/resources', async () => {
  const { RES } = await import('../helpers/suggestionsFixture');
  return { loadResources: () => RES };
});
// public/notebooks/requirements.txt is C-NB's file and does not exist yet: only that one stat is answered here.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    statSync: ((p: string, ...rest: unknown[]) =>
      String(p).endsWith('/public/notebooks/requirements.txt') ? { size: 2048 } : (real.statSync as (...a: unknown[]) => unknown)(p, ...rest)) as typeof real.statSync,
  };
});

describe('S-27, the controls page', () => {
  it('FR-SUG-04 FR-SUG-05 FR-SUG-06: S-27 lists every control with only released notebooks and passed templates', () => {
    const html = renderToStaticMarkup(<ControlsPage />);
    const c = runningContent();
    for (const k of c.controls.values()) expect(html).toContain(`id="${k.id}"`);
    expect(html).toContain('/notebooks/C-13_subgroup-fairness.ipynb');
    expect(html).not.toContain('C-21_monitoring-drift');
    expect(html).not.toMatch(/github\.com\/Alvin-Nahabwe|coming soon/i);
    expect(html).not.toContain('C-02_cost-benefit-impact');
    expect(html).toContain('/templates/C-01_alternatives-analysis.html');
  });

  it('UX-13 FR-SUG-04: one h2 per control type with its count, a card per control, and links to its risk areas', () => {
    const html = renderToStaticMarkup(<ControlsPage />);
    const c = runningContent();
    const n = (t: string) => [...c.controls.values()].filter((k) => k.type === t).length;
    expect(html).toContain('<h1>Controls</h1>');
    expect(html).toContain(`${c.controls.size} controls`);
    for (const [t, w] of [['technical', 'Technical'], ['procedural', 'Procedural'], ['informational', 'Informational']] as const) {
      expect(html).toContain(`>${w} (${n(t)})</h2>`);
    }
    expect(html.match(/<article class="ctl-card"/g)).toHaveLength(c.controls.size);
    expect(html).toContain('href="/explore/framework#area-card-PP-01"');
    expect(html).toContain('Risk areas:');
    expect(html).not.toContain('<button');
  });

  it('FR-SUG-04: no file under app, components or lib links a template or notebook path except through the resources file', () => {
    // A quote before /templates/ keeps the e-mail templates (@/lib/email/templates/...) out of the match: they are not a served file.
    expect(execSync(`grep -rln "[\\"']/templates/\\|notebooks/technical\\|NOTEBOOK_BASE_URL" app components lib --include=*.ts --include=*.tsx | grep -v '^lib/content/resources.ts$' || true`).toString().trim()).toBe('');
  });
});
