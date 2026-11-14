import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { readCreditLine } from '@/lib/credit';
import { isClaim } from '@/lib/claims/pattern';
import { releaseWaiver } from '../helpers/releaseWaivers';

/**
 * The page and the credit line read their files with `readFileSync`. The mock
 * delegates to the real one, so every case but the hostile-address one reads
 * the committed files.
 */
const fsMock = vi.hoisted(() => ({ readFileSync: vi.fn() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  fsMock.readFileSync.mockImplementation(actual.readFileSync);
  return { ...actual, default: actual, readFileSync: fsMock.readFileSync };
});

import AboutPage, { metadata } from '@/app/(public)/about/page';
import { ABOUT_COPY } from '@/lib/about/copy';
import { pageTitle } from '@/lib/ui/title';
import { TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3 } from '@/lib/vocabulary/terms';

/**
 * S-28, the public About page (FR-PUB-01, FR-PUB-02, FR-PUB-04, FR-PUB-05, UX-03).
 *
 * `AboutPage` is a server component with no hooks, so it renders to static
 * markup under vitest's `environment: 'node'`. The axe and keyboard checks of
 * the same page need a browser and are in `e2e/about.spec.ts`.
 */

const html = renderToStaticMarkup(<AboutPage />);

/** Markup to plain text: tags dropped, the four entities React writes decoded. */
const plain = (s: string): string =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

const text = plain(html);

/** The markup of one section: from the `<h2>` that carries the id to the next `<h2>`. */
function section(markup: string, id: string): string {
  const at = markup.search(new RegExp(`<h2[^>]*id="${id}"`));
  if (at === -1) throw new Error(`no <h2 id="${id}"> on the About page`);
  const rest = markup.slice(at + 1);
  const next = rest.search(/<h2[\s>]/);
  return next === -1 ? markup.slice(at) : markup.slice(at, at + 1 + next);
}

/** Drops every element that carries `data-claims-allowed`, balancing nested tags of the same name. */
function stripClaimsAllowed(markup: string): string {
  let out = markup;
  const open = /<([a-z][a-z0-9]*)\b[^>]*\sdata-claims-allowed="[^"]*"[^>]*>/i;
  for (;;) {
    const m = open.exec(out);
    if (!m) return out;
    const tag = m[1];
    const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = m.index + m[0].length;
    let depth = 1;
    let end = re.lastIndex;
    for (let t = re.exec(out); t && depth > 0; t = depth > 0 ? re.exec(out) : null) {
      depth += t[1] ? -1 : 1;
      end = re.lastIndex;
    }
    if (depth !== 0) throw new Error(`unbalanced <${tag}> inside a data-claims-allowed element`);
    out = out.slice(0, m.index) + out.slice(end);
  }
}

const helpContact = (): { email: string | null } =>
  JSON.parse(readFileSync('data/help-contact.json', 'utf8'));
const PENDING = ABOUT_COPY.help.pending;
const helpEmailOrPendingText = (): string => {
  const { email } = helpContact();
  return email === null ? PENDING : email;
};

/** Renders the page as if the data file whose name ends in `suffix` held `content`. */
function renderWithFile(suffix: string, content: string): string {
  const real = fsMock.readFileSync.getMockImplementation()!;
  fsMock.readFileSync.mockImplementation(((path: unknown, ...rest: unknown[]) =>
    String(path).endsWith(suffix)
      ? content
      : (real as (...a: unknown[]) => unknown)(path, ...rest)) as typeof real);
  try {
    return renderToStaticMarkup(<AboutPage />);
  } finally {
    fsMock.readFileSync.mockImplementation(real);
  }
}

const renderWithHelpContact = (content: string): string => renderWithFile('help-contact.json', content);

describe('S-28 About page', () => {
  // CONSOLIDATED section 4 (owner ruling): the no-score principle stays a product rule, not About text.
  it('About has no section about scores', () => {
    expect(html).not.toContain('id="why-no-score"');
    expect(html).not.toMatch(/<h[1-6][^>]*>[^<]*\bscores?\b[^<]*<\/h[1-6]>/i);
    for (const gone of ['Why there is no score', 'What you get instead', 'Earlier versions of this tool', 'simulated sets of answers']) {
      expect(text, gone).not.toContain(gone);
    }
  });

  it('FR-PUB-04: the section "What the platform does" says the platform does not test your model or calculate anything from your data', () => {
    expect(plain(section(html, 'what-this-is'))).toContain('The platform does not test your model or calculate anything from your data.');
    // The section "What this platform never does" is removed (CONSOLIDATED section 4); its one fact is the sentence above.
    expect(html).not.toContain('id="never-runs"');
    expect(text).not.toContain('What this platform never does');
  });

  it('FR-PUB-01: the About page says who can see records, and never that MAK-AI cannot', () => {
    // The owner's four sentences (14 November 2026, Q18), word for word.
    const owner =
      'Every member of your organisation can read its records. Other organisations cannot. The MAK-AI administrator has no access to your records in the platform. The people at MAK-AI who run the server can reach the database for technical work.';
    expect(ABOUT_COPY.whatItDoes.whoCanSee.text).toBe(owner);
    expect(plain(section(html, 'what-this-is'))).toContain(`${ABOUT_COPY.whatItDoes.whoCanSee.heading} ${owner}`);
    expect(text).not.toMatch(/cannot see your records/i);
  });

  it('FR-PUB-02: the About page carries the credit line read from the file', () => {
    const credit = readCreditLine();
    const s = plain(section(html, 'credit'));
    expect(s).toContain(credit.text);
    expect(section(html, 'credit')).toContain(`href="${credit.href}"`);
  });

  it('UX-03 NFR-A11Y-04: Help and contact gives the address, asks for the support reference, and says never to send record text', () => {
    const s = plain(section(html, 'help-and-contact'));
    expect(s).toMatch(/support reference/i);
    expect(s).toContain(ABOUT_COPY.help.noRecords);
    expect(ABOUT_COPY.help.noRecords).toMatch(/^Do not put your records in the email/);
    expect(s).toContain(helpEmailOrPendingText());
  });

  it('FR-PUB-01 FR-PUB-05: every sentence that names a score sits inside a data-claims-allowed element', () => {
    expect(text).toMatch(/\d\s?%/);
    const outside = plain(stripClaimsAllowed(html));
    expect(outside).not.toMatch(/\bscores?\b|\d\s?%/i);
    // The strip removed something, so the check above is not vacuous.
    expect(outside.length).toBeLessThan(text.length);
  });

  it("FR-PUB-05: the allowed elements are the not-an-approval sentence and the one sentence about a model's own score", () => {
    const reasons = [...html.matchAll(/data-claims-allowed="([^"]*)"/g)].map((m) => m[1]);
    expect(reasons.sort()).toEqual(['about-model-scores', 'not-an-approval-service']);
    expect(plain(html.match(/<[a-z0-9]+[^>]*data-claims-allowed="about-model-scores"[^>]*>[\s\S]*?<\/[a-z0-9]+>/)![0])).toMatch(
      /"60% likely"/,
    );
  });

  it('FR-PUB-01 FR-PUB-05: every marked element holds exactly one allow-listed sentence, and each sentence is marked once', () => {
    // SRS 7.5.3: "the only exceptions are these exact sentences". A marker may not shelter any other text.
    const marked: string[] = [];
    const open = /<([a-z][a-z0-9]*)\b[^>]*\sdata-claims-allowed="[^"]*"[^>]*>/gi;
    for (let m = open.exec(html); m; m = open.exec(html)) {
      const re = new RegExp(`<(/?)${m[1]}\\b[^>]*>`, 'gi');
      re.lastIndex = m.index + m[0].length;
      let depth = 1;
      let end = re.lastIndex;
      for (let t = re.exec(html); t && depth > 0; t = depth > 0 ? re.exec(html) : null) {
        depth += t[1] ? -1 : 1;
        end = t.index;
      }
      marked.push(plain(html.slice(m.index + m[0].length, end)));
      // A spoken attribute on a marked element, or on anything inside it, would be exempt from every check.
      expect(html.slice(m.index, end), 'a spoken attribute inside a marker').not.toMatch(/\s(aria-label|aria-description|title|alt|placeholder|value)=/);
    }
    expect(marked.sort()).toEqual(
      [
        ABOUT_COPY.whatItDoes.notApproval,
        ABOUT_COPY.principles.awareness.marked,
      ].sort(),
    );
  });

  it('FR-PUB-01: a model-score sentence holds no banned word besides "60% likely"', () => {
    const marked = [...html.matchAll(/<span[^>]*data-claims-allowed="about-model-scores"[^>]*>([\s\S]*?)<\/span>/g)];
    expect(marked).toHaveLength(1);
    for (const m of marked) {
      const rest = plain(m[1]).replace(/"60% likely"/g, '');
      expect(isClaim(rest), rest).toBe(false);
    }
  });

  it('FR-PUB-05: the platform states what it is not, in the exact allow-listed sentence', () => {
    expect(text).toContain(
      'The platform does not approve, audit or certify AI systems. Its documents are your team\'s own record, not an approval.',
    );
    expect(ABOUT_COPY.whatItDoes.notApproval).toBe(
      'The platform does not approve, audit or certify AI systems. Its documents are your team\'s own record, not an approval.',
    );
    const reasons = [...html.matchAll(/data-claims-allowed="([^"]*)"/g)].map((m) => m[1]);
    expect(reasons).toContain('not-an-approval-service');
  });

  it('1A Task 12 R10: what a seal shows is on Help; About keeps one link to it, with its words, in the section on what this is', () => {
    expect(html).not.toContain('what-a-seal-proves');
    expect(section(html, 'what-this-is')).toContain('<p><a href="/help#what-sealing-means">What sealing means</a></p>');
    expect(html.match(/What sealing means/g)).toHaveLength(1);
    // the last paragraph before "Who can see your records", so it does not read as part of that subsection (fix round 1, F6 c)
    expect(section(html, 'what-this-is')).toMatch(/<p><a href="\/help#what-sealing-means">What sealing means<\/a><\/p><h3>Who can see your records<\/h3>/);
  });

  // CONSOLIDATED section 4: the eyebrow repeated the h1; "Free toolkits" became the controls page's introduction
  // (its test is in controls-page.test.tsx); the UNCST table left Help and contact, which the Footer still links to.
  it('UX-03: About has no eyebrow and no free toolkits section, and Help and contact keeps its id and holds no table', () => {
    expect(html).not.toContain('about-eyebrow');
    expect(text).not.toContain('About the platform');
    expect(html).not.toContain('id="free-toolkits"');
    expect(text).not.toContain('Free toolkits');
    const help = section(html, 'help-and-contact');
    expect(help).not.toMatch(/<table[\s>]/);
    expect(plain(help)).not.toMatch(/UNCST|protocol/);
  });

  it('FR-PUB-05: the principle sections keep the ids other pages link to', () => {
    for (const slug of [
      'fairness',
      'proportionality',
      'transparency',
      'accountability',
      'safety',
      'awareness',
      'collaboration',
      'sustainability',
    ]) {
      expect(html, slug).toContain(`id="principle-${slug}"`);
    }
  });

  it('NFR-SEC-11: markup in the Help and contact address is refused at read, so it never reaches the page', () => {
    expect(() => renderWithHelpContact(JSON.stringify({ email: '<b>x</b>@example.org' }))).toThrow(/help-contact/);
  });

  it('NFR-SEC-11 FR-PUB-02: the credit line on S-28 renders as text, not markup', () => {
    const hostile = renderWithFile(
      'credit.json',
      JSON.stringify({ text: '<b>x</b> GIZ', href: 'https://creativecommons.org/licenses/by-sa/4.0/', licence: 'CC BY-SA 4.0' }),
    );
    expect(section(hostile, 'credit')).toContain('&lt;b&gt;x&lt;/b&gt; GIZ');
    expect(hostile).not.toContain('<b>x</b>');
  });

  it('UX-03: a named address shows as "Write to <address>" with a mailto link, and the pending sentence is gone', () => {
    const named = section(renderWithHelpContact(JSON.stringify({ email: 'help@makrai.example' })), 'help-and-contact');
    expect(plain(named)).toContain('Write to help@makrai.example');
    expect(named).toContain('href="mailto:help@makrai.example"');
    expect(plain(named)).not.toContain(PENDING);
  });

  it('UX-03: only an explicit null shows the pending sentence; anything else that is not an address is refused', () => {
    expect(plain(section(renderWithHelpContact(JSON.stringify({ email: null })), 'help-and-contact'))).toContain(PENDING);
    for (const bad of [
      '{}',
      'null',
      '[]',
      '{"email":""}',
      '{"email":5}',
      '{"email":"TBD"}',
      '{"email":"null"}',
      '{"email":"mailto:help@makrai.example"}',
      '{"email":"help@makrai.example "}',
      '{"email":"help@makrai.example?subject=hello"}',
      '{"email":"help@makrai.example?body=paste%20your%20decisions"}',
      '{"email":"help@makrai.example#x"}',
      '{"email":"help@makrai.example/path"}',
      '{"email":null,"Email":"help@makrai.example"}',
      '{"email":null,"address":"somewhere"}',
      '{"email":',
    ]) {
      expect(() => renderWithHelpContact(bad), bad).toThrow(/help-contact/);
    }
  });

  // Shown as skipped, not passed, when RELEASE_CANDIDATE is not 1. The pending sentence promises an address
  // "before the platform opens to teams" (13.8 step 4d).
  it.runIf(process.env.RELEASE_CANDIDATE === '1')('UX-03: with RELEASE_CANDIDATE=1 the Help and contact address is named, not pending', () => {
    // The owner shipped the pending text (UX-03, "Ship pending text"): a complete waiver covering data/help-contact.json
    // passes this case (docs/releases/release-waivers.json); without one the address must be named.
    const waived = releaseWaiver('UX-03 help-contact-pending')?.covers.includes('data/help-contact.json') === true;
    expect(helpContact().email !== null || waived, 'the address is pending and no owner waiver covers it').toBe(true);
  });

  it('1A Task 19 (AB3, Q20): the heading spells out the product name once, from the copy module', () => {
    expect(html).toContain(`<h1>${ABOUT_COPY.hero.heading}</h1>`);
    expect(ABOUT_COPY.hero.heading).toBe('About the MAK-AI Responsible AI (RAI) Platform');
    expect(readFileSync('app/(public)/about/page.tsx', 'utf8')).not.toContain('MAK-AI RAI Platform');
  });

  it("1A Task 19 (Q15, L5-11): the three stage lines pair the content's name with the vocabulary's definition", () => {
    const s = plain(section(html, 'what-this-is'));
    expect(s).toContain(ABOUT_COPY.whatItDoes.intro);
    for (const t of [TERM_STAGE_1, TERM_STAGE_2, TERM_STAGE_3]) {
      expect(html, t.term).toContain(`<li><strong>${t.term}.</strong> ${t.definition}</li>`);
    }
  });

  it('1A Task 19 (Q17): the paragraph on what the team records is the ruled one, word for word', () => {
    expect(plain(section(html, 'what-this-is'))).toContain(
      'For each question, your team records a decision, the reason, who decided, when, and any evidence. The team decides; the platform records. If a decision does not meet good practice, a finding is raised. Your team closes each finding in one of two ways: it fixes the problem (a mitigation), or it records that it accepts the risk. When your team is ready, it seals a stage review. Sealing fixes the record so it cannot change. The platform then makes documents from it for your ethics committee or funder. The platform does not test your model or calculate anything from your data.',
    );
  });

  it('1A Task 19 (Q19, AB37o): the two sentences the coordinator changed, and the energy paragraph has no "five cars" figure', () => {
    expect(text).toContain('Keep the code, a record of which data was used, and the settings, so the results can be produced again.');
    expect(text).toContain('A safe system shows clearly when something goes wrong, so people can handle it.');
    expect(text).not.toMatch(/five cars|data version/);
    expect(text).toContain('Risk areas');
    expect(text).not.toMatch(/assessment areas/i);
  });

  it('1A Task 19 (L5-15): the band holds no decoration and nothing on the page moves or wears a hand-typed colour', () => {
    expect(html).not.toMatch(/page-hero__(bg|grid-overlay|accent-line)|page-hero--animated|--stage-color|style="/);
    const css = readFileSync('app/(public)/about/AboutPage.css', 'utf8');
    expect(css).not.toMatch(/@keyframes|animation|transition/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(css).not.toMatch(/border-(left|right)\s*:\s*(?!1px)\d/);
    expect(css).not.toMatch(/content\s*:\s*'\u2713/);
    expect(css).not.toMatch(/--color-primary/);
  });

  it('UX-03 WCAG 2.4.2: the page title says which page it is', () => {
    expect(metadata.title).toBe(pageTitle(ABOUT_COPY.titles.about));
  });
});
