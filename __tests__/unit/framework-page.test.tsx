import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import FrameworkPage from '@/app/(authenticated)/explore/framework/page';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { principleSlugMap, stageLabels } from '@/data/constants';
import { STAGES } from '@/types/record';
import { HOSTILE_STRINGS } from '../helpers/hostile';

/**
 * S-26, the framework reference page (FR-CNT-01, UX-36; contract Screens row S-26): a server component that lists
 * every stage, module, risk area and control of the running content in its HTML, before any script runs. It runs on
 * H0's fixture bundle (the running content of every vitest file).
 */

/** React's text escaping of `&`, `<`, `>`, `"` and `'`. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const PAGE = 'app/(authenticated)/explore/framework/page.tsx';

afterEach(() => {
  vi.doUnmock('@/lib/content/loader');
  vi.resetModules();
});

describe('S-26 framework page', () => {
  // framework-page.test.tsx (fixture content)
  const html = renderToStaticMarkup(<FrameworkPage />);

  it('FR-CNT-01 UX-36: S-26 lists every stage, module, risk area and control in the server HTML', () => {
    const c = runningContent();
    for (const s of STAGES) expect(html).toContain(stageLabels[s].label);
    for (const a of c.areas.values()) { expect(html).toContain(`id="area-card-${a.id}"`); expect(html).toContain(escape(a.name)); }
    for (const k of c.controls.values()) expect(html).toContain(`href="/explore/controls#${k.id}"`);
    expect(html).toContain('3 stages, 6 modules, 21 risk areas, 28 controls');
  });

  it('FR-CNT-01: S-26 copy keeps the 7.5 rules', () => {
    expect(html).not.toMatch(/[–—]/);
    expect(html.replace(/<[^>]+>/g, ' ')).not.toMatch(/\b(score|scoring|compliance|compliant|certified|certification|maturity|readiness|rating|aligned with|fixes?)\b/i);
  });

  it('FR-CNT-01 NFR-SEC-11: S-26 escapes hostile content text', async () => {
    vi.resetModules();
    vi.doMock('@/lib/content/loader', async (orig) => {
      const m = await orig<typeof import('@/lib/content/loader')>(); const c = m.runningContent();
      const [first, ...rest] = [...c.areas.values()];
      return { ...m, runningContent: () => ({ ...c, areas: new Map([[first.id, { ...first, name: HOSTILE_STRINGS[0], context: HOSTILE_STRINGS[1] }], ...rest.map((a) => [a.id, a] as const)]) }) };
    });
    const { default: Page } = await import('@/app/(authenticated)/explore/framework/page');
    const out = renderToStaticMarkup(<Page />);
    expect(out).not.toContain('<script>'); expect(out).not.toContain('<img'); expect(out).toContain('&lt;script&gt;');
  });

  it('FR-CNT-01 (R-62): each module is listed under its stage with its number of questions, read from the content', () => {
    const c = runningContent();
    for (const s of STAGES) {
      const section = html.slice(html.indexOf(`id="stage-${s}"`), STAGES.indexOf(s) < 2 ? html.indexOf(`id="stage-${STAGES[STAGES.indexOf(s) + 1]}"`) : undefined);
      const byModule = new Map<string, { title: string; n: number }>();
      for (const q of questionsInStage(c, s)) byModule.set(q.moduleId, { title: q.moduleTitle, n: (byModule.get(q.moduleId)?.n ?? 0) + 1 });
      expect(byModule.size).toBeGreaterThan(0);
      for (const { title, n } of byModule.values()) expect(section, `${s} ${title}`).toContain(`${escape(title)}, ${n} questions`);
      for (const a of c.areas.values()) if (a.stage === s) expect(section).toContain(`id="area-card-${a.id}"`);
    }
  });

  it('FR-CNT-01 NFR-A11Y-02: one h1 "Framework", an h2 per stage, and every area card names its principle as text with its controls as links', () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*>Framework<\/h1>/);
    for (const s of STAGES) expect(html).toMatch(new RegExp(`<h2[^>]*id="stage-${s}"[^>]*>${stageLabels[s].label}</h2>`));
    const c = runningContent();
    const area = [...c.areas.values()][0];
    const card = html.slice(html.indexOf(`id="area-card-${area.id}"`));
    expect(card).toContain(`Principle: ${escape(area.principle)}`);
    for (const id of area.controls ?? []) expect(card).toContain(`href="/explore/controls#${id}">${escape(c.controls.get(id)!.name)}</a>`);
  });

  it('UX-03 FR-PUB-02 FR-CNT-01: every area card links its principle to its section of the About page', () => {
    const c = runningContent();
    for (const a of c.areas.values()) {
      const slug = principleSlugMap[a.principle];
      expect(slug, `${a.id} ${a.principle} has a section of /about`).toBeDefined();
      const card = html.slice(html.indexOf(`id="area-card-${a.id}"`));
      expect(card).toMatch(new RegExp(`^[^]*?<a [^>]*href="/about#principle-${slug}"[^>]*>Principle: ${escape(a.principle).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</a>`));
    }
  });

  it('UX-36 FR-CNT-01: S-26 is a server component that reads content only through the loader', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).not.toMatch(/['"]use client['"]|dangerouslySetInnerHTML|useState|useEffect/);
    expect(src).toMatch(/import \{[^}]*\brunningContent\b[^}]*\} from '@\/lib\/content\/loader'/);
    expect(src).not.toMatch(/data\/assessmentAreas\.json|data\/questionBank\.json|data\/content/);
    expect(html).not.toMatch(/<button[^>]*lifecycle-node/);   // no stage buttons: nothing waits for a click
  });
});
