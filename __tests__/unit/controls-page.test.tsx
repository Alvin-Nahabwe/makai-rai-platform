import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import ControlsPage from '@/app/(authenticated)/explore/controls/page';
import { runningContent } from '@/lib/content/loader';
import { GUIDANCE_COPY } from '@/lib/guidance/copy';
import { TERM_CONTROL, TERM_MITIGATION, TERM_MODEL_CARD, TERM_RISK_AREA } from '@/lib/vocabulary/terms';

/** React's escaping of a text child, for the copy's apostrophes and ampersands. */
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;');
/** The page's h1: "Controls", the first use of the term on the page (B5). */
const H1 = `<h1><span data-term="${TERM_CONTROL.id}">${GUIDANCE_COPY.titles.controls}</span></h1>`;

vi.mock('@/lib/content/resources', async () => {
  const { RES } = await import('../helpers/suggestionsFixture');
  return { loadResources: () => RES };
});
/** The guard's grep patterns, one list for the real tree and for the scratch files that prove it catches each quoting style. */
const GUARD_PATTERNS = ['-e', '["\'`]/templates/', '-e', '["\'`]/notebooks/', '-e', 'notebooks/technical', '-e', 'NOTEBOOK_BASE_URL'];

describe('S-27, the controls page', () => {
  it('FX2 (B5 concern 2): the first card whose description says "model card" leads with the term, marked, and its definition; no other card does', () => {
    const html = renderToStaticMarkup(<ControlsPage />);
    expect(html.match(new RegExp(`data-term="${TERM_MODEL_CARD.id}"`, 'g'))).toHaveLength(1);
    expect(html.match(new RegExp(`data-definition="${TERM_MODEL_CARD.id}"`, 'g'))).toHaveLength(1);
    // Outside the control names (which the crawl skips, ruling X-1 (3); C-17's is "Model Documentation (Model Card)"), the
    // marked use is the page's first.
    const text = html.replace(/<h3 class="ctl-card__title">[^<]*<\/h3>/g, '');
    const first = text.search(/model cards?(?![\p{L}\p{N}])/iu);
    expect(text.slice(first - 40, first)).toContain(`<span data-term="${TERM_MODEL_CARD.id}">`);
    // FX4 (DF I5): the line after the description names its subject before the definition.
    expect(html).toMatch(new RegExp(`<p class="term-line"><span data-term="${TERM_MODEL_CARD.id}">Model card</span>\\. <span class="ui-definition" data-definition="${TERM_MODEL_CARD.id}">[^<]*</span></p><p class="ctl-card__desc">[^<]*model cards?`, 'i'));
  });


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
    expect(html).toContain(H1);
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
  // B5: the page opens with the control's Definition under the h1, then the line, each defined term beside its definition.
  it("UX-13 UX-03: S-27 opens with the line that took over the About page's free toolkits section", () => {
    const html = renderToStaticMarkup(<ControlsPage />);
    const [before, term, after] = GUIDANCE_COPY.controls.introLine;
    // The h1 is the first use of "control" and its Definition is the next element (spec 6); the line's one defined term,
    // "mitigation", has its Definition on its own line, the next element (FX4, DF I4: no definition runs on in a sentence).
    expect(html).toContain(
      `${H1}<p class="ui-definition" data-definition="${TERM_CONTROL.id}">${esc(TERM_CONTROL.definition)}</p>`
      + `<p class="controls-page__intro">${before}<span data-term="${TERM_MITIGATION.id}">${term}</span>${after}</p>`
      + `<p class="ui-definition" data-definition="${TERM_MITIGATION.id}">${esc(TERM_MITIGATION.definition)}</p>`,
    );
    expect(GUIDANCE_COPY.controls.introLine.join('')).toBe('When your team adds a mitigation, it can follow one of these.');
    // "Risk areas:" under each card would be the first use of "risk area"; the header names it first, with its Definition.
    const [aBefore, aTerm, aAfter] = GUIDANCE_COPY.controls.areasLine;
    const areas = `<p class="controls-page__intro">${aBefore}<span data-term="${TERM_RISK_AREA.id}">${aTerm}</span>${aAfter}</p>`
      + `<p class="ui-definition" data-definition="${TERM_RISK_AREA.id}">${esc(TERM_RISK_AREA.definition)}</p>`;
    expect(html).toContain(areas);
    expect(html.indexOf(areas)).toBeLessThan(html.indexOf(GUIDANCE_COPY.controls.riskAreas));
    expect(GUIDANCE_COPY.controls.areasLine.join('')).toBe('Each control lists the risk areas it addresses.');
    expect(html).not.toMatch(/practice that lowers a risk|links to free guidance/);
    expect(html.indexOf(TERM_CONTROL.definition)).toBeLessThan(html.indexOf('<h2'));
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
