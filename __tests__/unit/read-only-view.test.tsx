import { readFileSync } from 'node:fs';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { QuestionOpenWork } from '@/lib/question/openWork';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView, EvidenceItemView } from '@/types/api';
import { PROJECT_COPY } from '@/lib/project/copy';
import { AUTHZ_COPY } from '@/lib/authz/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { runningContent } from '@/lib/content/loader';
import { stageFixture } from '../helpers/stageFixture';
import { TERM_FINDING, TERM_MITIGATION, TERM_SEAL, TERM_STAGE_REVIEW } from '@/lib/vocabulary/terms';
import { webLink } from '@/lib/evidence/format';

/**
 * The read-only question page (plan 1C Task 7, decision C12; the Route rebuild's lane 1 Task 3, to
 * directions/surfaces/viewer-reading.png): a person who may not record (a Reviewer, a Viewer, any role in an archived
 * project) reads "What the team decided" as one white card, then what is still open on the question directly under it;
 * the reader's aside (the sealed copy, the one line that says why there is no form, the way on to the next question)
 * opens the guidance column. ReadingDecision, OpenWorkList, ReadingAside and QuestionFindingLink are the REAL ones here;
 * the loaders are mocked (fixture and mocks from s12-shell.test.tsx and question-frame.test.tsx).
 */
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: () => null }));
vi.mock('@/components/suggestions/SuggestedControls', async (original) => ({
  ...(await original<typeof import('@/components/suggestions/SuggestedControls')>()),
  SuggestedControls: () => null,
}));
const requireIdentity = vi.fn();
const requireOrgContextFor = vi.fn();
const loadQuestionPanel = vi.fn();
const loadQuestionOpenWork = vi.fn();
vi.mock('@/lib/auth/identity', () => ({ requireIdentity: (...a: unknown[]) => requireIdentity(...a) }));
vi.mock('@/lib/auth/context', () => ({ requireOrgContextFor: (...a: unknown[]) => requireOrgContextFor(...a) }));
vi.mock('@/lib/question/panel', () => ({ loadQuestionPanel: (...a: unknown[]) => loadQuestionPanel(...a) }));
vi.mock('@/lib/question/openWork', () => ({ loadQuestionOpenWork: (...a: unknown[]) => loadQuestionOpenWork(...a) }));
// The route column's stage list (lane 7) is not this file's subject: its load answers the fixture stage with nothing
// recorded (the page refuses a null one, lane 1 Task 1).
vi.mock('@/lib/question/stagePage', async () => {
  const { stageFixture } = await import('../helpers/stageFixture');
  return { loadStagePage: async () => stageFixture() };
});

const { default: QuestionPage, QuestionPanelRegions } = await import(
  '@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page'
);

const R = QUESTION_COPY.reading;

const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you evaluated whether AI is the right approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'Compare simpler options first.', whyAsked: 'A simpler tool may be safer.', reasonPrompt: 'z', evidenceExamples: [],
  stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
const LINK: EvidenceItemView = {
  id: 'e1', kind: 'link', url: 'https://example.org/a', label: 'Audit report', fileName: null, mimeType: null, byteSize: null, sha256: null,
  uploadedBy: null, uploadedAt: '2026-11-10T08:00:00.000Z', erased: null,
} as EvidenceItemView;
const FILE: EvidenceItemView = {
  id: 'e2', kind: 'file', url: null, label: null, fileName: 'representativeness-check.pdf', mimeType: 'application/pdf', byteSize: 412_000,
  sha256: 'ab', uploadedBy: null, uploadedAt: '2026-02-18T08:00:00.000Z', erased: null,
} as EvidenceItemView;
const CURRENT = {
  id: 'dv2', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 2, baseVersionNumber: 1,
  content: { semver: '0.0.1-fixture' }, optionsInPlace: [], status: 'done', scopeAnswer: null, reasonCode: null,
  reason: 'We compared a rules engine first.', reasonErased: null,
  decidedBy: { kind: 'member', user: { userId: 'u3', name: 'Joseph Mugisha', formerMember: false } }, declaredDate: '2026-02-18', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: 'u2', name: 'Joseph K.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-11-10T08:30:00.000Z',
  evidence: [FILE, LINK],
} as unknown as DecisionVersionView;
const SEAL = { sealId: 's1', sealNumber: 1, reviewId: 'r1', reviewName: 'Pre-processing review 1' };
const PANEL: QuestionPanelData = {
  orgSlug: 'acme-health', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: QUESTION, runningQuestion: QUESTION, position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' },
  current: CURRENT, historyCount: 2, seals: [SEAL],
  reasonCodes: [], members: [{ userId: 'u1', name: 'Amina N.' }], viewer: { userId: 'u1', name: 'Amina N.', role: 'viewer' },
  canWrite: false, canRaiseFinding: false, lastOwnSaveDate: null, openFinding: { findingId: 'f1' }, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const VIEWER = PANEL;
const REVIEWER: QuestionPanelData = { ...PANEL, viewer: { ...PANEL.viewer, role: 'reviewer' }, canRaiseFinding: true };
const WORK: QuestionOpenWork = {
  findings: [
    { findingId: 'f1', title: 'Have you evaluated whether AI is the right approach?', mitigations: [
      { what: 'Run the rules-engine baseline', assignedTo: 'Grace W.', dueDate: '2026-11-01', overdue: true, status: 'in_progress' },
      { what: null, assignedTo: 'Peter O.', dueDate: '2026-12-01', overdue: false, status: 'planned' },
    ] },
    { findingId: 'f2', title: 'No baseline was kept', mitigations: [] },
  ],
};

const render = async (data: QuestionPanelData, openWork: QuestionOpenWork | null = WORK): Promise<string> =>
  renderToStaticMarkup(await QuestionPanelRegions({ data, openWork, stage: stageFixture() }));
const regions = (html: string): string[] => [...html.matchAll(/data-region="([a-z-]+)"/g)].map((m) => m[1]);
const main = (html: string): string => html.match(/<div class="question-workspace__main">([\s\S]*?)<div class="question-workspace__guide">/)![1];
const guide = (html: string): string => html.slice(html.indexOf('<div class="question-workspace__guide">'));
/** The decision card: from its section to the open-work section, or to the end of the main column. */
const card = (html: string): string => {
  const m = main(html);
  const end = m.indexOf('<section data-region="open-work"');
  return m.slice(m.indexOf('<section data-region="current-decision"'), end < 0 ? undefined : end);
};
const aside = (html: string): string => html.match(/<div class="reading-aside" data-region="reading-aside">[\s\S]*?<\/div><\/div>/)![0];
const textOf = (html: string): string => html.replace(/<[^>]+>/g, '');

beforeEach(() => {
  requireIdentity.mockReset().mockResolvedValue({ userId: 'u1', email: 'a@x.test' });
  requireOrgContextFor.mockReset().mockResolvedValue({ orgId: 'o1', role: 'viewer' });
  loadQuestionPanel.mockReset().mockResolvedValue({ ...PANEL, projectName: 'P' });
  loadQuestionOpenWork.mockReset().mockResolvedValue(WORK);
});

describe('the read-only question page (plan 1C Task 7)', () => {
  it('U12 d: a Viewer and a Reviewer see the reason text and the evidence names', async () => {
    for (const data of [VIEWER, REVIEWER]) {
      const c = card(await render(data));
      expect(c).toContain('<blockquote class="reading-decision__reason">We compared a rules engine first.</blockquote>');
      expect(c).toContain('Audit report');
      expect(c).toContain('representativeness-check.pdf');
      // The evidence is a part of the card, not a landmark of its own (review M7): a div with its heading.
      expect(c).toContain('<div class="reading-evidence"><h3>Evidence</h3>');
      expect(c).not.toMatch(/<section[^>]*aria-labelledby="s12-evidence"/);
      // Who decided, bold under the quotation; who entered it, quietly, with the received time (principle 4: both pairs).
      expect(c).toMatch(/<figcaption class="reading-decision__decided">Decided by Joseph Mugisha<span aria-hidden="true"> · <\/span>18 Feb 2026<\/figcaption>/);
      expect(c).toContain('Entered by: Joseph K.');
    }
  });

  it('UX-14: neither has a form, a textarea, the save bar, the answer-form region or "Record a decision"', async () => {
    for (const data of [VIEWER, REVIEWER]) {
      const html = await render(data);
      expect(html).not.toMatch(/<form\b/);
      expect(html).not.toMatch(/<textarea\b/);
      expect(html).not.toMatch(/<input\b|<select\b|<button\b/);
      expect(html).not.toContain('decision-save-bar');
      expect(html).not.toContain('data-region="answer-form"');
      expect(html).not.toContain(QUESTION_COPY.headings.record);
      expect(html).not.toContain(QUESTION_COPY.headings.current);
    }
  });

  it('C12: the decision is one card headed "What the team decided"; the open findings sit directly under it; the reader\'s aside opens the guidance column', async () => {
    const html = await render(REVIEWER);
    const m = main(html);
    expect(m).toContain('<section data-region="current-decision" aria-labelledby="s12-current-decision" class="reading-decision"><div class="reading-decision__head"><h2 id="s12-current-decision">What the team decided</h2>');
    expect(m).toContain('<section data-region="open-work" aria-labelledby="s12-open-work" class="still-open"><h2 id="s12-open-work">Still open on this question: 2 findings</h2>');
    // The main column holds the question, the card and what is still open, in that order and nothing else: the seal note
    // (a sentence about saving) and the foot's way on are the writer's; the reader's way on is in the aside.
    expect(regions(m)).toEqual(['question', 'current-decision', 'open-work']);
    expect(m).toMatch(/<\/section><section data-region="open-work"/);
    expect(m).not.toContain('data-permission-note');
    // The guidance column: the reader's aside first, then the guidance, then the finding link.
    const g = guide(html);
    expect(regions(g).slice(0, 3)).toEqual(['reading-aside', 'guidance', 'finding-link']);
    expect(aside(html)).toContain(`<p class="reading-aside__note" data-permission-note="true">`);
    expect(aside(html)).toContain(AUTHZ_COPY.decisionFormNote.reviewer);
    expect(aside(await render(VIEWER))).toContain(AUTHZ_COPY.decisionFormNote.viewer);
    // One finding is counted in the singular.
    expect(await render(VIEWER, { findings: [WORK.findings[1]] })).toContain('<h2 id="s12-open-work">Still open on this question: 1 finding</h2>');
  });

  it('spec 9.3: the status mark and its word sit in the card\'s top right, a text node apart from the version', async () => {
    const c = card(await render(VIEWER));
    const head = c.match(/<div class="reading-decision__head">[\s\S]*?<\/div>/)![0];
    expect(head).toMatch(/<\/h2><p class="reading-decision__state"><span class="ui-mark ui-mark--done" data-mark-kind="done">/);
    expect(textOf(head)).toBe('What the team decidedDone');
    expect(c).toContain('<span>Version 2</span>');
    expect(c).toContain('<span>saved 10 Nov 2026</span>');
  });

  it('the personal data question shows its answer in the card\'s corner', async () => {
    const gate = { ...QUESTION, id: 'Q-PP-GATE-SENSITIVE', type: 'gate' } as LoadedQuestion;
    const c = card(await render({ ...VIEWER, question: gate, runningQuestion: gate, current: { ...CURRENT, status: null, scopeAnswer: 'no' } as never }));
    expect(c).toContain('data-mark-kind="scope_answered"');
    expect(textOf(c.match(/<p class="reading-decision__state">[\s\S]*?<\/p>/)![0])).toMatch(/No/);
  });

  it('the history link reads "History: n versions" in the reading view', async () => {
    const html = await render(VIEWER);
    expect(html).toContain('>History: 2 versions</a>');
    expect(html).not.toContain('See all versions');
    expect(await render({ ...VIEWER, historyCount: 1 })).toContain('>History: 1 version</a>');
  });

  it('gap 2: a link is its name, then the host it goes to and "opens another site", with the external mark; never the whole address', async () => {
    const c = card(await render(VIEWER));
    expect(c).toMatch(/<a class="reading-evidence__link" href="https:\/\/example.org\/a" rel="noopener noreferrer"><bdi>Audit report<\/bdi> <span class="reading-evidence__host">\(example.org, opens another site\)<\/span><svg class="ui-icon"/);
    expect(textOf(c)).not.toContain('https://example.org/a');
    // A link the person gave no name is named by its address once, and still shows its host (silent-failure review of
    // 4e544208, finding 2: a look-alike or user:password@ address fools the eye without it).
    const bare = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...LINK, label: null }] } }));
    expect(textOf(bare).split('https://example.org/a')).toHaveLength(2);
    expect(textOf(bare)).not.toContain('(https://');
    expect(textOf(bare)).toContain('https://example.org/a (example.org, opens another site)');
    const trick = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...LINK, label: null, url: 'https://gov.example@evil.example/' }] } }));
    expect(trick).toContain('>(evil.example, opens another site)</span>');
  });

  it('link spoofing (a): a name that claims another site shows the host the link really goes to', async () => {
    const spoof = { ...LINK, label: 'gov.example \u2014 official', url: 'https://evil.example/login' };
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [spoof] } }));
    expect(c).toContain('>(evil.example, opens another site)</span>');
    expect(c).toMatch(/href="https:\/\/evil.example\/login"/);
    // A look-alike host is shown in the form the browser resolves (punycode), not as the letters that imitate another.
    const idn = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...LINK, url: 'https://\u0440\u0430ypal.example/' }] } }));
    expect(idn).toContain('(xn--ypal-43d9g.example,');
  });

  it('link spoofing (review M1): a name that copies the suffix cannot pass for it; the real host is its own quieter element', async () => {
    const copy = { ...LINK, label: 'Report (gov.example, opens another site)', url: 'https://evil.example/' };
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [copy] } }));
    expect(c).toContain('<bdi>Report (gov.example, opens another site)</bdi> <span class="reading-evidence__host">(evil.example, opens another site)</span>');
    expect([...c.matchAll(/class="reading-evidence__host"/g)]).toHaveLength(1);
    const css = readFileSync('components/question/reading.css', 'utf8');
    const rule = /\.reading-evidence__host\s*\{([^}]*)\}/.exec(css)![1];
    expect(rule).toMatch(/color:\s*var\(--color-ink-muted\)/);
    expect(rule).toMatch(/font-weight:\s*var\(--font-weight-regular\)/);
  });

  it('link spoofing: the address is parsed once, so the href the browser follows and the host shown are the same (silent-failure review of 4e544208, finding 1)', async () => {
    // "https:evil.example" is a relative address in a browser on an https page (the platform's own origin), while a parse
    // without a base reads evil.example; the anchor must carry the parsed absolute address.
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...LINK, url: 'https:evil.example' }] } }));
    expect(c).toContain('href="https://evil.example/"');
    expect(c).not.toContain('href="https:evil.example"');
    expect(c).toContain('>(evil.example, opens another site)</span>');
    expect(webLink('https:/api/logout?x')).toEqual({ href: 'https://api/logout?x', host: 'api' });
  });

  it('link spoofing (b) and (c): an address that does not parse is shown whole, its bidi controls removed, as text, and nothing throws', async () => {
    for (const url of ['https://evil\u202Eelpmaxe.vog/a', 'not a web address \u2066x\u2069']) {
      const c = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...LINK, url }] } }));
      expect(c).not.toContain('reading-evidence__link');
      expect(c).not.toMatch(/[\u202A-\u202E\u2066-\u2069]/);
      expect(c).toContain(`<bdi>Audit report</bdi> (<bdi>${url.replace(/[\u202A-\u202E\u2066-\u2069]/g, '')}</bdi>)`);
      expect(c).not.toContain('opens another site');
    }
    expect(webLink('https://ex\u2066ample.org/x')).toBeNull();
    expect(webLink('not a url')).toBeNull();
    expect(webLink('javascript:alert(1)')).toBeNull();
    expect(webLink('ftp://files.example/a')).toBeNull();
    expect(webLink('https://user:pw@evil.example:8443/p')).toEqual({ href: 'https://user:pw@evil.example:8443/p', host: 'evil.example' });
  });

  it('times on the card are East Africa Time, as the server-rendered organisation events write them (formatDay and formatTime with Africa/Kampala)', async () => {
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, receivedAt: '2026-11-10T22:30:00.000Z', evidence: [{ ...FILE, uploadedAt: '2026-02-18T21:30:00.000Z' }] } as never }));
    // 22:30 UTC is 01:30 EAT on the next day: the day and the time both follow the zone, and the zone is named.
    expect(c).toContain('Entered by: Joseph K. on 11 Nov 2026 at 01:30 EAT');
    expect(c).toContain('<span>saved 11 Nov 2026</span>');
    expect(c).toContain('added 19 Feb 2026');
    expect(c).not.toContain('UTC');
  });

  it('a file is its name, "<size> · added <date>", and a secondary Download button that names the file to a screen reader', async () => {
    const c = card(await render(VIEWER));
    expect(c).toContain('<bdi>representativeness-check.pdf</bdi>');
    expect(c).toMatch(/<small>412 KB<span aria-hidden="true"> · <\/span>added 18 Feb 2026<\/small>/);
    expect(c).toMatch(/<a class="ui-button ui-button--secondary reading-evidence__download" href="\/api\/v1\/orgs\/acme-health\/evidence\/e2" download="">/);
    expect(c).toMatch(/Download<span class="visually-hidden"> representativeness-check.pdf<\/span><\/a>/);
    // An erased file reads its erased line and has no Download.
    const erased = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...FILE, erased: { erasedOn: '2026-11-01' } }] } as never }));
    expect(erased).toContain('File erased on');
    expect(erased).not.toContain('reading-evidence__download');
  });

  it('design review S4-2, S4-3, S2-5: the reason is a quotation, a link\'s name and host are one run of text, and nothing in the reading view is under 14 px', () => {
    const css = readFileSync('components/question/reading.css', 'utf8');
    // Every rule whose whole selector is `sel`, bodies joined.
    const rule = (sel: string): string => [...css.matchAll(new RegExp(`(?<![\\w:-])${sel.replace(/[.[\]()]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]).join(';');
    expect(rule('.reading-decision__reason')).toMatch(/quotes:\s*'\u201C'\s*'\u201D'/);
    expect(rule('.reading-decision__reason::before')).toMatch(/content:\s*open-quote/);
    expect(rule('.reading-decision__reason::after')).toMatch(/content:\s*close-quote/);
    // The link is inline text, so its name and the host wrap as one run, never as two columns.
    expect(rule('.reading-evidence__link')).not.toMatch(/display:\s*inline-flex/);
    expect(css).not.toContain('--font-size-legal');
    expect(readFileSync('components/question/OpenWorkList.css', 'utf8')).not.toContain('--font-size-legal');
  });

  it('with no evidence the card says "None yet"', async () => {
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [] } }));
    expect(c).toContain(`<p>${R.noEvidence}</p>`);
    expect(R.noEvidence).toBe('None yet');
  });

  it('spec 9.7: a withdrawn decision is struck through with who withdrew it, when and why, never removed', async () => {
    const withdrawn = { ...CURRENT, versionNumber: 3, baseVersionNumber: 2, status: 'withdrawn', withdrawalCode: 'duplicate', reason: 'Saved twice by mistake.', decidedBy: null, declaredDate: null, evidence: [] } as unknown as DecisionVersionView;
    const c = card(await render({ ...VIEWER, current: withdrawn, historyCount: 3 }));
    expect(c).toMatch(/<p class="reading-decision__withdrawn"><del>Version 2<\/del> was withdrawn by Joseph K\. on 10 Nov 2026 \(Duplicate\)\.<\/p>/);
    expect(c).toContain('<blockquote class="reading-decision__reason">Saved twice by mistake.</blockquote>');
    expect(c).toContain('data-mark-kind="no_decision"');
    expect(c).toContain('>History: 3 versions</a>');
    // A seal can hold the withdrawal (lib/seal/manifest.ts puts the current version in the seal whatever its status): the
    // card keeps its seal marker and the aside its sealed copy (silent-failure review of c46d69f4, finding 1).
    expect(c).toContain('In seal 1 of Pre-processing review 1');
    expect(aside(await render({ ...VIEWER, current: withdrawn, historyCount: 3 }))).toContain('Seal 1 of Pre-processing review 1 keeps version 3 of this decision.');
    // The version the seal keeps is the withdrawal, version 3: the card names it on its version line, as the history page
    // lists a withdrawal as a version, so the aside names nothing the card does not show (review M2).
    expect(c).toMatch(/<p class="reading-decision__version"><span>Version 3<\/span><span aria-hidden="true"> · <\/span><span>saved 10 Nov 2026<\/span>/);
  });

  it('with no decision yet the card says so and holds nothing else', async () => {
    const c = card(await render({ ...VIEWER, current: null, historyCount: 0, seals: [] }));
    expect(c).toContain(`<p>${QUESTION_COPY.current.none}</p>`);
    expect(c).not.toContain('History:');
  });

  it('the first use of "finding" and "mitigation" on the page sits beside their vocabulary definitions, under the heading', async () => {
    const open = main(await render(VIEWER)).match(/<section data-region="open-work"[\s\S]*?<\/section>/)![0];
    // Each definition shows its term (design review S4-1): a reader can tell which sentence defines which word.
    expect(open).toContain(`</h2><p class="reading-def"><b class="reading-def__term">Finding:</b> <span class="ui-definition" data-definition="finding">${TERM_FINDING.definition}</span></p>`);
    expect(open).toContain(`<p class="reading-def"><b class="reading-def__term">Mitigation:</b> <span class="ui-definition" data-definition="mitigation">${TERM_MITIGATION.definition}</span></p>`);
    expect(open).toContain(TERM_FINDING.definition);
    expect(open).toContain(TERM_MITIGATION.definition);
  });

  it('each finding is a plate linking to its page; every open mitigation is one line of what, then who, status and due; one with none says so', async () => {
    const work = main(await render(VIEWER)).match(/<section data-region="open-work"[\s\S]*?<\/section>/)![0];
    expect(work).toMatch(/<a [^>]*href="\/orgs\/acme-health\/projects\/p1\/findings\/f1"[^>]*><bdi>Have you evaluated whether AI is the right approach\?<\/bdi><\/a>/);
    expect(work).toMatch(/<a [^>]*href="\/orgs\/acme-health\/projects\/p1\/findings\/f2"[^>]*><bdi>No baseline was kept<\/bdi><\/a>/);
    const [f1, f2] = work.split('href="/orgs/acme-health/projects/p1/findings/').slice(1);
    expect(f1).toContain('<p class="still-open__what">Mitigation: Run the rules-engine baseline</p>');
    const erased = PROJECT_COPY.followUp.erased.replace("'", '&#x27;');
    expect(f1).toContain(`<p class="still-open__what">${erased}</p>`);
    expect(f1).not.toContain(`Mitigation: ${erased}`);
    expect(f1).toContain('<span>Assigned to: Grace W.</span>');
    expect(f1).toContain('<span>Assigned to: Peter O.</span>');
    expect(f1).toContain('<span class="status-label">In progress</span>');
    expect(f1).toContain('<span class="status-label">Planned</span>');
    expect(f1).toContain('<span>Due 1 Dec 2026</span>');
    expect(f1).not.toContain(R.noMitigationYet);
    expect(f2).toContain(`<span>${R.noMitigationYet}</span><span>${R.notAssignedYet}</span>`);
    expect(f2).not.toContain('Mitigation:');
    // The retired word for the person a mitigation is assigned to (vocabulary "Assigned to") is not used.
    expect(textOf(work)).not.toMatch(/\bOwner:/);
  });

  it('with no open finding there is no open-work section and no heading', async () => {
    for (const html of [await render(VIEWER, { findings: [] }), await render(VIEWER, null)]) {
      expect(html).not.toContain('open-work');
      expect(html).not.toContain('Still open on this question');
    }
  });

  it('spec 7.1: data-overdue holds the clock, the word Overdue and the due date, and no name, title or mitigation text', async () => {
    const html = await render(VIEWER);
    expect(html.match(/data-overdue/g)).toHaveLength(1);
    const overdue = html.match(/<span class="still-open__overdue" data-overdue="true">([\s\S]*?)<\/span><\/p>/)![1];
    expect(overdue).toMatch(/^<svg class="ui-icon"[\s\S]*?<\/svg>Overdue<span aria-hidden="true"> · <\/span>was due 1 Nov 2026$/);
    for (const s of ['Grace W.', 'Run the rules-engine baseline', 'Have you evaluated']) expect(overdue).not.toContain(s);
    // The red class is on that element only.
    expect([...html.matchAll(/class="[^"]*still-open__overdue[^"]*"/g)]).toHaveLength(1);
  });

  it('the way on: "Next: question n" as the page\'s one primary link, with "Question n of N in <stage>" under it', async () => {
    const a = aside(await render(VIEWER));
    expect(a).toMatch(/<a class="ui-button ui-button--primary" href="\/orgs\/acme-health\/projects\/p1\/stages\/pre-processing\/questions\/Q-PP-02">Next: question 2<span class="ui-button__icon">/);
    expect(a).toContain('<p>Question 2 of 24 in Pre-processing</p>');
    expect((await render(VIEWER)).match(/ui-button--primary/g)).toHaveLength(1);
  });

  it('on the stage\'s last question the way on is the last-question sentence and All questions', async () => {
    const a = aside(await render({ ...VIEWER, position: { index: 23, total: 24, previousId: 'Q-PP-23', nextId: null } }));
    expect(a).toContain(`<p>${QUESTION_COPY.foot.last}</p>`);
    expect(a).toMatch(/<a href="\/orgs\/acme-health\/projects\/p1\/stages\/pre-processing">All questions<\/a>/);
    expect(a).not.toContain('ui-button--primary');
  });

  it('spec 9.7: in a sealed copy, one sentence per review names the seal and the version it keeps, with the vocabulary\'s definitions', async () => {
    const a = aside(await render(VIEWER));
    // A part of the reader's aside, not a landmark of its own (review M7): a div with its heading.
    expect(a).toMatch(/<div class="reading-aside__seal"><h2>In a sealed copy<\/h2><p>Seal 1 of Pre-processing review 1 keeps version 2 of this decision.<\/p>/);
    expect(a).not.toContain('<section');
    // Each definition shows its term, the vocabulary's own word (design review S4-1).
    expect(a).toContain(`<p class="reading-def"><b class="reading-def__term">Stage review:</b> <span class="ui-definition" data-definition="stage-review">${TERM_STAGE_REVIEW.definition}</span></p>`);
    expect(a).toContain(`<p class="reading-def"><b class="reading-def__term">Seal:</b> <span class="ui-definition" data-definition="seal">${TERM_SEAL.definition.replace("'", '&#x27;')}</span></p>`);
    // Two seals of one review: the highest speaks.
    const two = aside(await render({ ...VIEWER, seals: [SEAL, { ...SEAL, sealId: 's2', sealNumber: 2 }] }));
    expect(two).toContain('Seal 2 of Pre-processing review 1 keeps');
    expect(two).not.toContain('Seal 1 of');
    // A question in no seal has no sealed-copy section.
    expect(aside(await render({ ...VIEWER, seals: [] }))).not.toContain('In a sealed copy');
  });

  it('UX-14: a Reviewer sees "Raise a finding about this question"; a Viewer does not and has no finding-link section', async () => {
    const reviewer = await render(REVIEWER);
    expect(reviewer).toContain('data-region="finding-link"');
    expect(reviewer).toContain(QUESTION_COPY.findingLink.raise);
    const viewer = await render(VIEWER);
    expect(viewer).not.toContain('data-region="finding-link"');
    expect(viewer).not.toContain(QUESTION_COPY.findingLink.raise);
    expect(viewer).not.toContain('s12-finding-link');
    // The guidance aside is as for everyone.
    expect(viewer).toContain('data-region="guidance"');
  });

  it('review M2: a Reviewer with an open platform-raised finding sees it once, in the open-work list, and the raise link stays in the aside', async () => {
    const html = await render(REVIEWER);
    expect(html.split('href="/orgs/acme-health/projects/p1/findings/f1"')).toHaveLength(2);
    expect(main(html)).toContain('href="/orgs/acme-health/projects/p1/findings/f1"');
    expect(html).not.toContain(QUESTION_COPY.findingLink.view);
    const g = guide(html);
    expect(g).toContain('data-region="finding-link"');
    expect(g).toContain(QUESTION_COPY.findingLink.raise);
  });

  it('workshop walk S3: a reader on a question the personal data answer switched off reads the sentence under the code line', async () => {
    const off = runningContent().questions.get('Q-PP-13')!;
    for (const data of [VIEWER, REVIEWER]) {
      const html = await render({ ...data, question: off, runningQuestion: off, gateAnswer: 'no' });
      const question = html.match(/<section data-region="question"[\s\S]*?<\/section>/)![0];
      expect(question).toMatch(/<p class="question-frame__code">[^<]*<\/p><p data-does-not-apply="true">/);
      expect(question).toContain(QUESTION_COPY.doesNotApply);
    }
    expect(await render(VIEWER)).not.toContain('data-does-not-apply');
  });

  it('UX-31 C12: in an archived project an Owner gets the reading view, no permission line, and the archived banner', async () => {
    const html = await render({ ...PANEL, viewer: { ...PANEL.viewer, role: 'owner' }, projectArchived: true, canWrite: false, canRaiseFinding: false });
    expect(html).toContain(PROJECT_COPY.archivedBanner);
    expect(html).toContain('What the team decided');
    expect(html).not.toContain('data-permission-note');
    expect(html).not.toContain('data-region="answer-form"');
    expect(html).not.toContain(QUESTION_COPY.headings.record);
    // The way on stays.
    expect(aside(html)).toContain('Next: question 2');
  });

  it('NFR-SEC-11: a hostile reason, finding title, mitigation text, file name and link label come out as text', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    const html = await render({ ...VIEWER, current: { ...CURRENT, reason: evil, evidence: [{ ...FILE, fileName: evil }, { ...LINK, label: evil }] } },
      { findings: [{ findingId: 'f9', title: evil, mitigations: [{ what: evil, assignedTo: evil, dueDate: '2026-11-01', overdue: true, status: 'planned' }] }] });
    expect(html).not.toContain('<img');
    // reason, file name (and its hidden repeat in the Download name), link label, title, mitigation text, assigned person.
    expect(html.split('&lt;img src=x onerror=alert(1)&gt;')).toHaveLength(8);
  });

  it('a link whose address is not http or https is shown as text, never as a link, and does not claim to open another site', async () => {
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...LINK, url: 'javascript:alert(1)' }] } }));
    expect(c).not.toContain('href="javascript');
    expect(c).toContain('<bdi>Audit report</bdi> (<bdi>javascript:alert(1)</bdi>)');
    expect(c).not.toContain('opens another site');
  });

  it('a stored file whose size or type is not known keeps its Download (the download route checks it) and drops only the size line', async () => {
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, evidence: [{ ...FILE, byteSize: null, mimeType: null }] } as never }));
    expect(c).toContain('reading-evidence__download');
    expect(c).not.toContain('KB');
    expect(c).toContain('added 18 Feb 2026');
  });

  it('with neither a reason nor who decided, the card draws no empty quotation figure', async () => {
    const c = card(await render({ ...VIEWER, current: { ...CURRENT, reason: null, decidedBy: null } }));
    expect(c).not.toContain('<figure');
  });

  it('a person who may record keeps the form: answer-form and "Current decision", no reading regions and no "What the team decided", even with openWork', async () => {
    const writer: QuestionPanelData = { ...PANEL, viewer: { ...PANEL.viewer, role: 'assessor' }, canWrite: true, canRaiseFinding: true };
    const withWork = await render(writer, WORK);
    expect(withWork).toContain('data-region="answer-form"');
    expect(withWork).toContain(`<h2 id="s12-current-decision">${QUESTION_COPY.headings.current}</h2>`);
    expect(withWork).not.toContain('data-region="open-work"');
    expect(withWork).not.toContain('data-region="reading-aside"');
    expect(withWork).not.toContain('What the team decided');
    expect(withWork).toContain('See all versions (2)');
    expect(withWork).toContain('data-region="seal-note"');
    expect(withWork).toContain('data-region="way-on"');
    expect(withWork).toBe(await render(writer, null));
  });
});

describe('the page loads the open work only for a reader (R3)', () => {
  const params = Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01' });
  const searchParams = Promise.resolve({});

  it('canWrite false: openWork is loaded with the context, the route ids and today, after the panel', async () => {
    const html = renderToStaticMarkup(await QuestionPage({ params, searchParams }));
    expect(loadQuestionOpenWork).toHaveBeenCalledTimes(1);
    expect(loadQuestionOpenWork).toHaveBeenCalledWith({ orgId: 'o1', role: 'viewer' },
      { projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
    expect(loadQuestionPanel.mock.invocationCallOrder[0]).toBeLessThan(loadQuestionOpenWork.mock.invocationCallOrder[0]);
    expect(html).toContain('Still open on this question: 2 findings');
  });

  it('canWrite true: openWork is not loaded', async () => {
    loadQuestionPanel.mockResolvedValueOnce({ ...PANEL, canWrite: true, projectName: 'P' });
    const html = renderToStaticMarkup(await QuestionPage({ params: Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-02' }), searchParams }));
    expect(loadQuestionOpenWork).not.toHaveBeenCalled();
    expect(html).toContain('data-region="answer-form"');
  });

  it('a failed open-work read fails the page, not "nothing open"', async () => {
    loadQuestionOpenWork.mockRejectedValueOnce(new Error('db down'));
    await expect(QuestionPage({ params: Promise.resolve({ slug: 'acme-health', id: 'p1', stage: 'pre-processing', questionId: 'Q-PP-03' }), searchParams })).rejects.toThrow('db down');
  });
});
