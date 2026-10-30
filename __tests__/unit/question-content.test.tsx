import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { QuestionContent } from '@/components/question/QuestionContent';
import { loadContent } from '@/lib/content/loader';
import { HOSTILE_STRINGS } from '../helpers/hostile';

/**
 * The S-12 question content slot (FR-CNT-02, UX-08, UX-36; contract Screens row S-12): the question text, its
 * principle, "What good looks like" and "Why this is asked", before any form control, on H0's fixture bundle.
 */

const q = loadContent('0.0.1-fixture').questions.get('Q-PP-01')!;
/** React's text escaping of `&`, `<`, `>`, `"` and `'`. */
const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('QuestionContent', () => {
  it('UX-08 FR-CNT-02: question, link, What good looks like, then Why this is asked, with no form control', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} />);
    const at = (s: string) => html.indexOf(s);
    expect([at(escape(q.text)), at('Ways teams address this (3)'), at('What good looks like'), at(escape(q.expectedPractice)), at('Why this is asked'), at(escape(q.whyAsked))].every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1]))).toBe(true);
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

  it('UX-08 (W-3): the id and module title, then the principle, then the question, as the wireframe orders them', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={2} />);
    const order = [html.indexOf(q.id), html.indexOf(escape(q.moduleTitle)), html.indexOf('Principle:'), html.indexOf(escape(q.text))];
    expect(order.every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1])), html).toBe(true);
    expect(html).toContain('Ways teams address this (2)');
  });

  it('NFR-A11Y-02 UX-08: the texts sit under real headings below the shell\'s region heading, and no id of the shell is repeated', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} />);
    // The shell names the region with its own <h2 id="s12-question">; this slot's headings sit one level below it.
    expect(html).not.toContain('id="s12-question"');
    expect(html).not.toMatch(/<h[12]\b/);
    expect(html).toMatch(new RegExp(`<h3[^>]*>${escape(q.text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</h3>`));
    expect(html).toMatch(/<h3[^>]*>What good looks like<\/h3>/);
    expect(html).toMatch(/<h3[^>]*>Why this is asked<\/h3>/);
  });

  it('UX-08 NFR-A11Y-05 (UX-34): the jump link is shown only below the two-column width, is at least 24 by 24 pixels, and keeps a visible focus ring', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} />);
    expect(html).toMatch(/<a class="question-content__jump" href="#suggestions">/);
    const css = readFileSync('components/question/QuestionContent.css', 'utf8');
    expect(readFileSync('components/question/QuestionContent.tsx', 'utf8')).toContain("import './QuestionContent.css';");
    // Hidden from 75rem: the shell's grid makes two columns of at least 24rem (48rem and its 1.5rem gap) once the
    // main area, the viewport less the 260px sidebar and two 2rem paddings, reaches 49.5rem, at a viewport of about 1180px.
    expect(css).toMatch(/@media \(width >= 75rem\) \{\s*\.question-content__jump \{\s*display: none;/);
    expect(css).toMatch(/\.question-content__jump \{[^}]*min-block-size: 24px;[^}]*min-inline-size: 24px;/);
    expect(css).toMatch(/\.question-content__jump:focus-visible \{[^}]*outline: 3px solid var\(--tint-brand-fg\);/);
    expect(css).not.toMatch(/outline: none|outline: 0/);
  });
});
