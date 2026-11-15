import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import FrameworkPage from '@/app/(authenticated)/explore/framework/page';
import { requireIdentity } from '@/lib/auth/identity';
import { questionsInStage, runningContent } from '@/lib/content/loader';
import { principleSlugMap, stageLabels } from '@/data/constants';
import { STAGES } from '@/types/record';
import { HOSTILE_STRINGS } from '../helpers/hostile';
import { claimMatches, isClaim } from '@/lib/claims/pattern';
import { GUIDANCE_COPY } from '@/lib/guidance/copy';
import { TERM_CONTROL, TERM_MODEL_CARD, TERM_RISK_AREA, TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';

/**
 * S-26, the framework reference page (FR-CNT-01, UX-36; contract Screens row S-26): a server component that lists
 * every stage, module, risk area and control of the running content in its HTML, before any script runs. It runs on
 * H0's fixture bundle (the running content of every vitest file).
 */

/** React's text escaping of `&`, `<`, `>`, `"` and `'`. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
const PAGE = 'app/(authenticated)/explore/framework/page.tsx';

// The page calls the gate first (security review 0.7.0, L-1); here it lets every render through.
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: vi.fn(async () => ({ userId: 'u-1' })) }));

afterEach(() => {
  vi.doUnmock('@/lib/content/loader');
  vi.resetModules();
});

describe('S-26 framework page', () => {
  // framework-page.test.tsx (fixture content)
  let html = '';
  beforeAll(async () => { html = renderToStaticMarkup(await FrameworkPage()); });

  it('UX-01 FR-ACC-04 (L-1): S-26 runs the gates itself, and a redirect from them stops the page before it renders', async () => {
    vi.mocked(requireIdentity).mockClear();
    await FrameworkPage();
    expect(requireIdentity).toHaveBeenCalledTimes(1);
    vi.mocked(requireIdentity).mockRejectedValueOnce(new Error('NEXT_REDIRECT'));
    await expect(FrameworkPage()).rejects.toThrow('NEXT_REDIRECT');
  });

  it('FR-CNT-01 UX-36: S-26 lists every stage, module, risk area and control in the server HTML', () => {
    const c = runningContent();
    for (const s of STAGES) expect(html).toContain(stageLabels[s].label);
    for (const a of c.areas.values()) { expect(html).toContain(`id="area-card-${a.id}"`); expect(html).toContain(escape(a.name)); }
    for (const k of c.controls.values()) expect(html).toContain(`href="/explore/controls#${k.id}"`);
    expect(html).toContain(GUIDANCE_COPY.framework.counts(3, 6, 21, 28));
    expect(html).toContain(escape(GUIDANCE_COPY.framework.lead(3, 6)));
  });

  it('FR-CNT-01 FR-PUB-01 (7.5.1, 7.5.3): S-26\'s own copy says none of the never-said words, and has no emoji, curly quote or dash', async () => {
    // The page's own words only: every content text (names, descriptions, contexts, principles, module titles, sources)
    // is replaced by a neutral one, because the wording of the content is C-TXT's (its QC-03) and is reported, not
    // tested, here. What remains is the page's headings, labels, counts and scope text.
    vi.resetModules();
    vi.doMock('@/lib/content/loader', async (orig) => {
      const m = await orig<typeof import('@/lib/content/loader')>(); const c = m.runningContent();
      const t = 'Content text';
      const areas = new Map([...c.areas].map(([id, a]) => [id, { ...a, name: t, principle: t, description: t, context: t,
        references: (a.references ?? []).map((r) => ({ ...r, citation: t, relevance: t })) }] as const));
      const controls = new Map([...c.controls].map(([id, k]) => [id, { ...k, name: t }] as const));
      const questions = new Map([...c.questions].map(([id, q]) => [id, { ...q, moduleTitle: t }] as const));
      return { ...m, runningContent: () => ({ ...c, areas, controls, questions }) };
    });
    const { default: Page } = await import('@/app/(authenticated)/explore/framework/page');
    const text = renderToStaticMarkup(await Page()).replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&');
    expect(text).toContain('Content text');
    // SRS 7.5.3 (line 2472): PUB's one pattern of the words that never appear (lib/claims/pattern.ts).
    expect(claimMatches(text)).toEqual([]);
    expect(isClaim(text)).toBe(false);
    // 7.5.1: no emoji, no curly quotes, no em or en dashes.
    expect(text).not.toMatch(/\p{Extended_Pictographic}|[‘’“”–—]/u);
  });

  it('FR-CNT-01 NFR-SEC-11: S-26 escapes hostile content text', async () => {
    vi.resetModules();
    vi.doMock('@/lib/content/loader', async (orig) => {
      const m = await orig<typeof import('@/lib/content/loader')>(); const c = m.runningContent();
      const [first, ...rest] = [...c.areas.values()];
      return { ...m, runningContent: () => ({ ...c, areas: new Map([[first.id, { ...first, name: HOSTILE_STRINGS[0], context: HOSTILE_STRINGS[1] }], ...rest.map((a) => [a.id, a] as const)]) }) };
    });
    const { default: Page } = await import('@/app/(authenticated)/explore/framework/page');
    const out = renderToStaticMarkup(await Page());
    expect(out).not.toContain('<script>'); expect(out).not.toContain('<img'); expect(out).toContain('&lt;script&gt;');
  });

  it('FR-CNT-01 (R-62): each module is listed under its stage with its number of questions, read from the content', () => {
    const c = runningContent();
    for (const s of STAGES) {
      const section = html.slice(html.indexOf(`id="stage-${s}"`), STAGES.indexOf(s) < 2 ? html.indexOf(`id="stage-${STAGES[STAGES.indexOf(s) + 1]}"`) : undefined);
      const byModule = new Map<string, { title: string; n: number }>();
      for (const q of questionsInStage(c, s)) byModule.set(q.moduleId, { title: q.moduleTitle, n: (byModule.get(q.moduleId)?.n ?? 0) + 1 });
      expect(byModule.size).toBeGreaterThan(0);
      for (const { title, n } of byModule.values()) expect(section, `${s} ${title}`).toContain(escape(GUIDANCE_COPY.framework.topicLine(title, n)));
      for (const a of c.areas.values()) if (a.stage === s) expect(section).toContain(`id="area-card-${a.id}"`);
    }
  });

  it('FR-CNT-01 NFR-A11Y-02: one h1 "Framework", an h2 per stage, and every area card names its principle as text with its controls as links', () => {
    expect(html.match(/<h1\b/g)).toHaveLength(1);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${GUIDANCE_COPY.framework.heading}</h1>`));
    for (const s of STAGES) expect(html).toMatch(new RegExp(`<h2[^>]*id="stage-${s}"[^>]*><span data-term="[^"]+">${stageLabels[s].label}</span></h2>`));
    const c = runningContent();
    const area = [...c.areas.values()][0];
    const card = html.slice(html.indexOf(`id="area-card-${area.id}"`));
    expect(card).toContain(`Principle: ${escape(area.principle)}`);
    for (const id of area.controls ?? []) expect(card).toContain(`href="/explore/controls#${id}">${escape(c.controls.get(id)!.name)}</a>`);
  });

  it('B5 (spec 6), FX4 (DF I4): the lead names risk areas and controls, each a Term with its Definition on its own line next', () => {
    const F = GUIDANCE_COPY.framework;
    const pair = (t: { id: string; definition: string }, words: readonly [string, string, string]) =>
      `${escape(words[0])}<span data-term="${t.id}">${words[1]}</span>${escape(words[2])}</p><p class="ui-definition" data-definition="${t.id}">${escape(t.definition)}</p>`;
    expect(html).toContain(`<p>${escape(F.lead(3, 6))} ${pair(TERM_RISK_AREA, F.areasLine)}<p>${pair(TERM_CONTROL, F.controlsLine)}`);
    expect(`${F.lead(3, 6)} ${F.areasLine.join('')} ${F.controlsLine.join('')}`).toBe(
      'The questions are grouped into 3 stages and 6 topics. Each question links to a risk area. Each risk area links to controls that reduce the risk.',
    );
  });

  it('B5 (D1): each stage heading is the stage name as a Term, with its Definition as the next element', () => {
    for (const [s, t] of [['pre-processing', TERM_STAGE_1], ['in-processing', TERM_STAGE_2], ['post-processing', TERM_STAGE_3]] as const) {
      expect(stageLabels[s].label).toBe(t.term);
      expect(html).toMatch(new RegExp(`<h2[^>]*id="stage-${s}"[^>]*><span data-term="${t.id}">${t.term}</span></h2><p class="ui-definition" data-definition="${t.id}">${escape(t.definition)}</p>`));
    }
  });

  it('B5 (spec 6), FX4 (DF I5): the first content text that uses "model card" marks it; the next element names the term, then its Definition', () => {
    const c = runningContent();
    const pattern = /(?<![\p{L}\p{N}])model\s+cards?(?![\p{L}\p{N}])/iu;
    const order = STAGES.flatMap((s) => [...c.areas.values()].filter((a) => a.stage === s));
    const first = order.find((a) => pattern.test(a.description) || pattern.test(a.context ?? ''));
    expect(first, 'the fixture has an area that names a model card').toBeDefined();
    const field = pattern.test(first!.description) ? first!.description : first!.context!;
    const m = pattern.exec(field)!;
    const marked = `${escape(field.slice(0, m.index))}<span data-term="${TERM_MODEL_CARD.id}">${escape(m[0])}</span>${escape(field.slice(m.index + m[0].length))}</p><p class="term-line">Model card. <span class="ui-definition" data-definition="${TERM_MODEL_CARD.id}">${escape(TERM_MODEL_CARD.definition)}</span></p>`;
    expect(html).toContain(marked);
    // Only that first use is marked and defined.
    expect(html.match(/data-term="model-card"/g)).toHaveLength(1);
    expect(html.match(/data-definition="model-card"/g)).toHaveLength(1);
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

  it('UX-36 FR-CNT-01: every research source of every area is in the server HTML, in a native disclosure', () => {
    const c = runningContent();
    for (const a of c.areas.values()) {
      const card = html.slice(html.indexOf(`id="area-card-${a.id}"`), html.indexOf('</li>', html.indexOf('references-list__items', html.indexOf(`id="area-card-${a.id}"`))));
      for (const r of a.references ?? []) expect(html, `${a.id} ${r.citation}`).toContain(escape(r.citation));
      if ((a.references ?? []).length > 0) expect(card).toMatch(new RegExp(`<details class="references-list"><summary class="references-list__toggle">${GUIDANCE_COPY.references.summary(a.references!.length).replace(/[()]/g, '\\$&')}</summary>`));
    }
  });

  it('NFR-A11Y-05 FR-CNT-01 (7.5.1): the shared references list is a server component with theme colours and no emoji', () => {
    const tsx = readFileSync('components/report/ReferencesList.tsx', 'utf8');
    const css = readFileSync('components/report/ReferencesList.css', 'utf8');
    expect(tsx).not.toMatch(/['"]use client['"]|useState|\p{Extended_Pictographic}/u);
    // Every colour is a theme token of app/globals.css, which both themes redefine: no fixed brand, grey or hex colour.
    expect(css).not.toMatch(/--color-primary|--color-gray-|rgba\(|#[0-9A-Fa-f]{3,8}\b/);
    expect(readFileSync('app/(authenticated)/explore/framework/FrameworkMapPage.css', 'utf8')).not.toMatch(/references-list/);
  });

  it('FR-CNT-01 (owner, "make it subtler"): no S-26 rule draws a thick one-side accent border; the marker triangle is the one exception', () => {
    const rules = (file: string) => [...readFileSync(file, 'utf8').replace(/\/\*[^]*?\*\//g, '').matchAll(/([^{}]+)\{([^}]*)\}/g)].map((m) => ({ file, selector: m[1].trim(), body: m[2] }));
    const all = [...rules('components/report/ReferencesList.css'), ...rules('app/(authenticated)/explore/framework/FrameworkMapPage.css')];
    const oneSide = /border-(left|right|top|bottom|inline-start|inline-end|block-start|block-end)(-width)?\s*:\s*([^;]*)/g;
    const thick = all.flatMap((r) => [...r.body.matchAll(oneSide)]
      .filter((m) => /\b([2-9]|\d{2,})(\.\d+)?px\b|\b(medium|thick)\b/.test(m[3]))
      .map((m) => `${r.file} ${r.selector}: ${m[0].trim()}`))
      // The open/closed marker is a triangle drawn from borders (review r1 M-5), not an accent; the stage heading's rule
      // underlines a heading across the full width.
      .filter((x) => !/\.references-list__toggle::before: border-inline-start/.test(x) && !/\.framework-stage__title: border-bottom/.test(x));
    expect(thick).toEqual([]);
  });

  it('FR-CNT-01 (review r1 M-5): the sources summary draws an open/closed marker, with no emoji or glyph', () => {
    const css = readFileSync('components/report/ReferencesList.css', 'utf8');
    // The inline-flex summary loses the native disclosure triangle in Chromium, so the list draws its own from borders.
    const closed = /\.references-list__toggle::before\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(closed, 'a ::before marker on the summary').toMatch(/content:\s*'';/);
    expect(closed).toMatch(/border-inline-start:[^;]*currentColor/);
    expect(css).toMatch(/\.references-list\[open\]\s*>\s*\.references-list__toggle::before\s*\{[^}]*transform:\s*rotate\(90deg\)/);
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce/);
  });

  it('FR-CNT-01 (Task 19): the scope disclosure and the area cards say the ruled words', () => {
    const F = GUIDANCE_COPY.framework;
    const scope = html.slice(html.indexOf('id="framework-scope"'), html.indexOf('id="stage-'));
    expect(scope).toContain(`<summary><strong>${F.scope.summary}</strong></summary>`);
    const [a, b, c, d, e] = F.scope.predictive;
    expect(scope).toContain(`<p>${escape(a)}<strong>${b}</strong>${escape(c)}<strong>${d}</strong>${escape(e)}</p>`);
    expect(scope).toContain(`<p>${escape(F.scope.bias)}</p>`);
    for (const { label, text } of [F.scope.standards, F.scope.principles]) expect(scope).toContain(`<p><strong>${label}</strong> ${escape(text)}</p>`);
    expect(scope).not.toMatch(/21|ADR|assessment areas/);
    const withExamples = [...runningContent().areas.values()].find((x) => x.context);
    expect(withExamples, 'the fixture has an area with examples').toBeDefined();
    expect(html).toContain(`<strong>${F.examples}</strong> `);
    expect(html).not.toContain('Context:');
    expect(html).not.toMatch(/\bmodules?\b|Modules/);
    expect(F.topicLine('T', 1)).toBe('T, 1 question');
  });

  it('UX-36 FR-CNT-01: S-26 is a server component that reads content only through the loader', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).not.toMatch(/['"]use client['"]|dangerouslySetInnerHTML|useState|useEffect/);
    expect(src).toMatch(/import \{[^}]*\brunningContent\b[^}]*\} from '@\/lib\/content\/loader'/);
    expect(src).not.toMatch(/data\/assessmentAreas\.json|data\/questionBank\.json|data\/content/);
    expect(html).not.toMatch(/<button[^>]*lifecycle-node/);   // no stage buttons: nothing waits for a click
  });
});
