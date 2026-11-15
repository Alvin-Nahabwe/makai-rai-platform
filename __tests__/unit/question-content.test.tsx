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
  it('UX-08 FR-CNT-02: What good looks like, then Why this is asked, the risk areas, then the folded list, with no form control', () => {
    const areas = [{ id: 'PP-01', name: 'Problem framing', href: '/explore/framework#area-card-PP-01' }];
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} riskAreas={areas}><p>the list</p></QuestionContent>);
    const at = (s: string) => html.indexOf(s);
    expect([at('What good looks like'), at(escape(q.expectedPractice)), at('Why this is asked'), at(escape(q.whyAsked)), at('Risk areas'), at('Problem framing'), at('Ways teams address this (3)'), at('the list')].every((n, i, a) => n >= 0 && (i === 0 || n > a[i - 1])), html).toBe(true);
    expect(html).not.toContain('Principle:');
    expect(html).not.toMatch(/<(input|select|textarea|form|button)\b/);
  });

  it('spec 6: "Risk areas" carries the risk area definition at its first use', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={0} riskAreas={[{ id: 'PP-01', name: 'n', href: '/h' }]} />);
    expect(html).toMatch(/<p class="question-content__areas-label"><span data-term="risk-area">Risk areas<\/span> <span class="ui-definition" data-definition="risk-area">/);
    expect(renderToStaticMarkup(<QuestionContent question={q} suggestionCount={0} riskAreas={[]} />)).not.toContain('Risk areas');
  });

  it('UX-08: no link when there is nothing to suggest (the gate)', () => {
    expect(renderToStaticMarkup(<QuestionContent question={q} suggestionCount={0} riskAreas={[]} />)).not.toContain('Ways teams address this');
  });

  it('FR-CNT-02 NFR-SEC-11: hostile content text is escaped in QuestionContent', () => {
    const html = renderToStaticMarkup(<QuestionContent question={{ ...q, expectedPractice: HOSTILE_STRINGS[0], whyAsked: HOSTILE_STRINGS[1] }} suggestionCount={1} riskAreas={[]} />);
    expect(html).not.toContain('<script>'); expect(html).not.toContain('<img'); expect(html).toContain('&lt;script&gt;');
  });

  it('UX-36: QuestionContent is a server component', () => {
    expect(readFileSync('components/question/QuestionContent.tsx', 'utf8')).not.toMatch(/['"]use client['"]|dangerouslySetInnerHTML/);
  });

  // CONSOLIDATED section 4, and plan 1C decision C1 (cut): the question text, its id and its module title are the page's
  // h1 and the code line under it, so the aside repeats none of them.
  it('UX-08 (W-3): the aside opens with What good looks like; the question text, id and module title are left to the page heading', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={2} riskAreas={[]} />);
    expect(html).not.toContain('question-content__meta');
    expect(html.startsWith('<aside class="question-content" data-region="guidance" aria-labelledby="s12-guidance"><h2 id="s12-guidance">What good looks like</h2>'), html).toBe(true);
    expect(html).not.toContain(escape(q.moduleTitle));
    expect(html).not.toContain(escape(q.text));
    expect(html).not.toContain(`${q.id} · `);   // the code line (the fixture's own texts name the id)
    expect(html).toContain('Ways teams address this (2)');
  });

  it('NFR-A11Y-02 UX-08: the texts sit under real headings one level below the page\'s h1, and no id of the shell is repeated', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} riskAreas={[]} />);
    // The page's h1 is the question (id="question-heading"); this aside's headings sit one level below it.
    expect(html).not.toContain('id="question-heading"');
    expect(html).not.toMatch(/<h[13-6]\b/);
    expect(html).toMatch(/<h2[^>]*>What good looks like<\/h2>/);
    expect(html).toMatch(/<h2[^>]*>Why this is asked<\/h2>/);
    expect(html.match(/<h2\b/g)).toHaveLength(2);
  });

  it('UX-08 NFR-A11Y-05 (UX-34): Ways teams address this is one details, folded by default, whose 44px summary is link-styled with the book icon', () => {
    const html = renderToStaticMarkup(<QuestionContent question={q} suggestionCount={3} riskAreas={[]}><p>the list</p></QuestionContent>);
    expect(html).toMatch(/<details class="question-content__ways" id="suggestions"><summary class="question-content__ways-summary"><svg class="ui-icon"[^>]*>[\s\S]*?<\/svg>Ways teams address this \(3\)<\/summary><div class="question-content__ways-list"><p>the list<\/p><\/div><\/details>/);
    expect(html.match(/<details/g)).toHaveLength(1);
    const css = readFileSync('components/question/QuestionContent.css', 'utf8');
    expect(readFileSync('components/question/QuestionContent.tsx', 'utf8')).toContain("import './QuestionContent.css';");
    expect(css).toMatch(/\.question-content__ways-summary \{[^}]*min-block-size: 44px;[^}]*color: var\(--color-link\);[^}]*text-decoration: underline;/);
    // The focus ring is the global :focus-visible rule's, never taken away here.
    expect(css).not.toMatch(/outline: none|outline: 0/);
    // Colour roles only (plan 1A Task 17): no name of the legacy aliases block of app/globals.css.
    expect(css).not.toMatch(/var\(--(text-muted|text-primary|text-body|font-size-(sm|lg|base)|tint-brand-fg)\)/);
  });

});
