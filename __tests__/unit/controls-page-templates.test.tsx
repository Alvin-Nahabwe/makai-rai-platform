import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ControlsLibraryPage from '@/app/(authenticated)/explore/controls/page';
import assessmentAreas from '@/data/assessmentAreas.json';
import resources from '@/data/resources.json';

vi.mock('next/navigation', () => ({
  usePathname: () => '/explore/controls',
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * FR-SUG-06: a template that did not pass review "is not linked anywhere". The controls page links the template of
 * each control from data/assessmentAreas.json (a file of the 4.0.0 bundle, so it cannot be edited); the page passes the
 * link on only when it is the file of a passed data/resources.json entry.
 */
const SERVED = new Set(resources.templates.filter((t) => t.review.outcome === 'passed').map((t) => t.file));
const hrefs = (html: string) => [...html.matchAll(/href="(\/templates\/[^"]+)"/g)].map((m) => m[1]);

describe('controls page template links', () => {
  it('FR-SUG-06: every template link on the rendered page is the file of a passed entry, and C-11 has none', () => {
    const html = renderToStaticMarkup(<ControlsLibraryPage />);
    const linked = hrefs(html);
    expect(linked.length).toBeGreaterThan(0);
    for (const h of linked) expect(SERVED.has(h), h).toBe(true);
    expect(html).not.toContain('C-11_informed-consent');
  });

  it('FR-SUG-06: no link in the data that lacks a passed entry reaches the page', () => {
    const unserved = assessmentAreas.controls.map((c) => c.template).filter((f): f is string => !!f && !SERVED.has(f));
    const linked = hrefs(renderToStaticMarkup(<ControlsLibraryPage />));
    for (const f of unserved) expect(linked, f).not.toContain(f);
  });

  it('FR-SUG-06: whatever the data holds, a control whose template has no passed entry shows no link (C-01 removed from the resources)', async () => {
    // Independent of the live data: C-01 stays in assessmentAreas.json, but its entry is taken out of the resources.
    vi.resetModules();
    vi.doMock('@/data/resources.json', () => ({
      default: { ...resources, templates: resources.templates.filter((t) => t.controlId !== 'C-01') },
    }));
    try {
      const { renderToStaticMarkup: render } = await import('react-dom/server');
      const { default: Page } = await import('@/app/(authenticated)/explore/controls/page');
      const html = render(<Page />);
      const c01 = assessmentAreas.controls.find((c) => c.id === 'C-01')?.template;
      expect(c01, 'C-01 still has a template link in the data').toBeTruthy();
      expect(hrefs(html)).not.toContain(c01);
      expect(hrefs(html).length).toBe(SERVED.size - 1);
    } finally {
      vi.doUnmock('@/data/resources.json');
      vi.resetModules();
    }
  });
});
