import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ControlsPage from '@/app/(authenticated)/explore/controls/page';
import resources from '@/data/resources.json';
import type { ResourcesFile } from '@/types/content';

// The page calls the gate first (security review 0.7.0, L-1); here it lets every render through.
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: vi.fn(async () => ({ userId: 'u-1' })) }));

/**
 * FR-SUG-06: a template that did not pass review "is not linked anywhere". The controls page links a control's template
 * only when it is the file of a passed data/resources.json entry (the ControlCard rule), so a held-back template, C-11's
 * informed-consent file held back by the owner on 6 Nov, is never linked. Ported from the page this unit replaced.
 */
const real = resources as ResourcesFile;
const SERVED = new Set(real.templates.filter((t) => t.review.outcome === 'passed').map((t) => t.file));
const hrefs = (html: string) => [...html.matchAll(/href="(\/templates\/[^"]+)"/g)].map((m) => m[1]);

describe('controls page template links', () => {
  it('FR-SUG-06: every template link on the rendered page is the file of a passed entry, and C-11 has none', async () => {
    const html = renderToStaticMarkup(await ControlsPage());
    const linked = hrefs(html);
    expect(linked.length).toBeGreaterThan(0);
    for (const h of linked) expect(SERVED.has(h), h).toBe(true);
    expect([...SERVED].sort()).toEqual([...new Set(linked)].sort());
    expect(html).not.toContain('C-11_informed-consent');
  });

  it('FR-SUG-06: whatever the data holds, a control whose template entry is not passed shows no link', async () => {
    // Independent of the live data: C-01's entry is failed, C-11 has a failed entry, C-02 stays passed.
    const data: ResourcesFile = {
      ...real,
      templates: [
        ...real.templates.map((t) => (t.controlId === 'C-01' ? { ...t, review: { ...t.review, outcome: 'failed' as const } } : t)),
        { controlId: 'C-11', file: '/templates/C-11_informed-consent.html', kind: 'web page', bytes: 1000, sha256: 'e'.repeat(64),
          review: { reviewer: 'r', date: '2026-11-06', outcome: 'failed' } },
      ],
    };
    vi.resetModules();
    vi.doMock('@/lib/content/resources', () => ({ loadResources: () => data }));
    try {
      const { renderToStaticMarkup: render } = await import('react-dom/server');
      const { default: Page } = await import('@/app/(authenticated)/explore/controls/page');
      const linked = hrefs(render(await Page()));
      expect(linked).not.toContain('/templates/C-01_alternatives-analysis.html');
      expect(linked).not.toContain('/templates/C-11_informed-consent.html');
      expect(linked).toContain('/templates/C-02_cost-benefit-impact.html');
      expect(linked.length).toBe(SERVED.size - 1);
    } finally {
      vi.doUnmock('@/lib/content/resources');
      vi.resetModules();
    }
  });
});
