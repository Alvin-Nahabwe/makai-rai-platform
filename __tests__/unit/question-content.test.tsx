import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuestionContent } from '@/components/question/QuestionContent';
import { loadContent } from '@/lib/content/loader';
import { HOSTILE_STRINGS } from '../helpers/hostile';

/**
 * The S-12 guidance slot (FR-CNT-02, UX-08, UX-36; contract Screens row S-12): "What good looks like", "Why this is
 * asked" and the principle, as the page's aside, with no form control, on H0's fixture bundle. The question text is the
 * page's h1 (plan 1C decision C1, cut to slice 1; question-frame.test.tsx checks it there).
 */

const q = loadContent('0.0.1-fixture').questions.get('Q-PP-01')!;
/** React's text escaping of `&`, `<`, `>`, `"` and `'`. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('QuestionContent', () => {
  it('UX-08 FR-CNT-02: What good looks like, then Why this is asked, the principle, then the link, with no form control', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} />);
    const at = (s: string) => html.indexOf(s);
    expect([at('What good looks like'), at(escape(q.expectedPractice)), at('Why this is asked'), at(escape(q.whyAsked)), at('Principle:'), at('Ways teams address this (3)')].every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1])), html).toBe(true);
    expect(html).toContain(`Principle: ${escape(q.principle)}`); expect(html).toContain('href="#suggestions"');
    expect(html).not.toMatch(/<(input|select|textarea|form|button)\b/);
  });

  it('UX-08: no link when there is nothing to suggest (the gate)', () => {
    expect(renderToStaticMarkup(<QuestionContent question={q} suggestionCount={0} />)).not.toContain('Ways teams address this');
  });

  it('FR-CNT-02 NFR-SEC-11: hostile content text is escaped in QuestionContent', () => {
    const html = renderToStaticMarkup(<QuestionContent question={{ ...q, expectedPractice: HOSTILE_STRINGS[0], whyAsked: HOSTILE_STRINGS[1] }} suggestionCount={1} />);
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;');
  });

  it('UX-36: QuestionContent is a server component', () => {
    expect(readFileSync('components/question/QuestionContent.tsx', 'utf8')).not.toMatch(/['"]use client['"]|dangerouslySetInnerHTML/);
  });

  // CONSOLIDATED section 4, and plan 1C decision C1 (cut): the question text, its id and its module title are the page's
  // h1 and the code line under it, so the aside repeats none of them.
  it('UX-08 (W-3): the aside opens with What good looks like; the question text, id and module title are left to the page heading', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={2} />);
    expect(html).not.toContain('question-content__meta');
    expect(html.startsWith('<aside class="question-content" data-region="guidance" aria-labelledby="s12-guidance"><h2 id="s12-guidance">What good looks like</h2>'), html).toBe(true);
    expect(html).not.toContain(escape(q.moduleTitle));
    expect(html).not.toContain(escape(q.text));
    expect(html).not.toContain(`${q.id} · `);   // the code line (the fixture's own texts name the id)
    expect(html).toContain('Ways teams address this (2)');
  });

  it('NFR-A11Y-02 UX-08: the texts sit under real headings one level below the page\'s h1, and no id of the shell is repeated', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} />);
    // The page's h1 is the question (id="question-heading"); this aside's headings sit one level below it.
    expect(html).not.toContain('id="question-heading"');
    expect(html).not.toMatch(/<h[13-6]\b/);
    expect(html).toMatch(/<h2[^>]*>What good looks like<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Why this is asked<\/h2>/);
    expect(html.match(/<h2\b/g)).toHaveLength(2);
  });

  it('UX-08 NFR-A11Y-05 (UX-34): the jump link is shown only while the guidance is not beside the form, is at least 24 by 24 pixels, and keeps a visible focus ring', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} />);
    expect(html).toMatch(/<a class="question-content__jump" href="#suggestions">/);
    const css = readFileSync('components/question/QuestionContent.css', 'utf8');
    expect(readFileSync('components/question/QuestionContent.tsx', 'utf8')).toContain("import './QuestionContent.css';");
    // Hidden by the same media query that puts the guidance beside the form (components/question/workspace.css): from
    // 90rem the three columns, the stage's questions, the main one and the guide; under it the guidance is below the form.
    expect(css).toMatch(/@media \(width >= 90rem\) \{\s*\.question-content__jump \{\s*display: none;/);
    expect(readFileSync('components/question/workspace.css', 'utf8'))
      .toMatch(/@media \(width >= 90rem\) \{\s*\.question-workspace \{\s*grid-template-columns: minmax\(16rem, 1fr\) minmax\(0, 2fr\) minmax\(16rem, 1fr\);\s*grid-template-areas: "route main guide";/);
    expect(css).not.toContain('75rem');
    expect(css).toMatch(/\.question-content__jump \{[^}]*min-block-size: 24px;[^}]*min-inline-size: 24px;/);
    expect(css).toMatch(/\.question-content__jump:focus-visible \{[^}]*outline: 3px solid var\(--color-action-text\);/);
    // Colour roles only (plan 1A Task 17): no name of the legacy aliases block of app/globals.css.
    expect(css).not.toMatch(/var\(--(text-muted|text-primary|text-body|font-size-(sm|lg|base)|tint-brand-fg)\)/);
    expect(css).not.toMatch(/outline: none|outline: 0/);
  });
});
