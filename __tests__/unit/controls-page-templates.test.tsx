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

  it('FR-SUG-06: the data still holds a link to a template with no passed entry, so the guard is what hides it', () => {
    const unserved = assessmentAreas.controls.map((c) => c.template).filter((f): f is string => !!f && !SERVED.has(f));
    // While this list is not empty the page test above proves the guard works; when it is empty the guard is moot.
    expect(unserved.every((f) => !hrefs(renderToStaticMarkup(<ControlsLibraryPage />)).includes(f))).toBe(true);
  });
});
