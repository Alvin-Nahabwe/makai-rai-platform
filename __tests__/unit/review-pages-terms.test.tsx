import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewPageHeader } from '@/components/review/ReviewPageHeader';
import { ReviewFacts, ReviewPageTop } from '@/components/review/ReviewPageTop';
import { OpenReviewForm } from '@/components/review/OpenReviewForm';
import { SealPreviewBody, sealPageTerms } from '@/components/review/SealPreviewBody';
import { previewParts, previewLines } from '@/components/review/reviewText';
import type { SealPreview } from '@/lib/data/reviews';
import { TERM_DONE, TERM_NOT_APPLICABLE, TERM_NOT_YET, TERM_PARTLY } from '@/lib/vocabulary/terms';
import { TERM_STAGE_3 } from '@/lib/vocabulary/terms';
import { REVIEW_COPY } from '@/lib/review/copy';
import { TERM_FINGERPRINT, TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION, TERM_SEAL, TERM_STAGE_1, TERM_STAGE_REVIEW } from '@/lib/vocabulary/terms';
import { firstUseProblems } from '../helpers/firstUseHtml';

/**
 * Lane 6, B4: first-use definitions on the stage review screens (spec 6; definitions-howto.md). Each page's heading
 * holds the first use of the terms in its words; their definitions sit in the list right under it, and the heading
 * names them with aria-describedby.
 */

const header = (title: string, titleTerms: Parameters<typeof ReviewPageHeader>[0]['titleTerms'], moreTerms = [] as Parameters<typeof ReviewPageHeader>[0]['titleTerms']) =>
  renderToStaticMarkup(<ReviewPageHeader idPrefix="t" breadcrumb={[{ label: 'Project', href: '/p' }, { label: title }]} title={title} titleTerms={titleTerms} moreTerms={moreTerms} />);

describe('ReviewPageHeader', () => {
  it('marks the heading\'s terms, lists their definitions under it and names them from the heading', () => {
    const out = header(REVIEW_COPY.titles.seal('Pre-processing review 1'), [TERM_SEAL, TERM_STAGE_1]);
    expect(out).toContain('<h1 class="ui-page-header__title" aria-describedby="t-seal t-stage-1"><span data-term="seal">Seal</span> &quot;<span data-term="stage-1">Pre-processing</span> review 1&quot;</h1>');
    expect(out).toMatch(/<dl class="term-list"><dt>Seal<\/dt><dd><span class="ui-definition" id="t-seal" data-definition="seal">[^<]+<\/span><\/dd><dt>Pre-processing<\/dt><dd><span class="ui-definition" id="t-stage-1" data-definition="stage-1">/);
    expect(firstUseProblems(out)).toEqual([]);
  });

  it('marks in the list a term the heading does not hold', () => {
    const out = header('Pre-processing review 1', [TERM_STAGE_1], [TERM_SEAL, TERM_FINGERPRINT]);
    expect(out).toContain('<dt><span data-term="seal">Seal</span></dt>');
    expect(out).toContain('<dt><span data-term="fingerprint">Fingerprint</span></dt>');
    expect(firstUseProblems(`${out}<p>Sealed as seal 1. Fingerprint 0a1b.</p>`)).toEqual([]);
  });

  it('leaves out a heading term the title does not use, and names nothing then', () => {
    const out = header(REVIEW_COPY.titles.openReview, [TERM_STAGE_REVIEW, TERM_STAGE_1]);
    expect(out).toContain('aria-describedby="t-stage-review"');
    expect(out).not.toContain('data-definition="stage-1"');
    expect(header('Review', [TERM_STAGE_1])).not.toContain('aria-describedby');
  });
});

describe('firstUseProblems (the test helper)', () => {
  it('reports an unmarked first use, a marked one with no definition beside it, and passes one with its definition next', () => {
    expect(firstUseProblems('<main><p>Seal 1</p></main>')).toEqual([{ id: 'seal', text: 'Seal 1' }]);
    expect(firstUseProblems('<p><span data-term="seal">Seal</span></p><div><p>y</p><p class="ui-definition" data-definition="seal">x</p></div>')).toEqual([{ id: 'seal', text: 'Seal' }]);
    expect(firstUseProblems('<p><span data-term="seal">Seal</span></p><p class="ui-definition" data-definition="seal">x</p><p>seal</p>')).toEqual([]);
    expect(firstUseProblems('<nav>Seal</nav><h1 aria-describedby="d"><span data-term="seal">Seal</span></h1><dl><dt>Seal</dt><dd><span data-definition="seal" id="d">x</span></dd></dl>')).toEqual([]);
  });
});

describe('S-16 the review page (S5, C 7)', () => {
  const view = { stage: 'pre-processing' as const, preparedFor: 'ethics submission', preparedForErased: null, openedBy: { userId: 'u', name: 'Amina N.', formerMember: false }, openedAt: '2026-10-30T08:00:00.000Z' };
  const F = REVIEW_COPY.review.facts;

  it('states the review\'s facts as a description list: Stage, Prepared for, Opened by', () => {
    const out = renderToStaticMarkup(<ReviewFacts view={view} />);
    expect(out).toContain(`<dl class="review-facts"><dt>${F.stage}</dt><dd>Pre-processing</dd><dt>${F.preparedFor}</dt><dd><bdi>ethics submission</bdi></dd><dt>${F.openedBy}</dt><dd><bdi>Amina N.</bdi> ${F.on} <time dateTime="2026-10-30T08:00:00.000Z">30 Oct 2026</time></dd></dl>`);
    expect(out).not.toContain(' · ');
  });

  it('says an erased note as the platform\'s line, and leaves out a note never given', () => {
    expect(renderToStaticMarkup(<ReviewFacts view={{ ...view, preparedFor: null, preparedForErased: { erasedOn: '2026-11-03' } }} />))
      .toContain(`<dt>${F.preparedFor}</dt><dd>${REVIEW_COPY.mounted.noteErased('3 Nov 2026')}</dd>`);
    expect(renderToStaticMarkup(<ReviewFacts view={{ ...view, preparedFor: null }} />)).not.toContain(F.preparedFor);
  });

  it('defines the stage, seal and fingerprint at the top, and the facts follow', () => {
    const out = renderToStaticMarkup(<ReviewPageTop name="Pre-processing review 1" breadcrumb={[{ label: 'P', href: '/p' }, { label: 'Pre-processing review 1' }]} view={view} hasSeals changedFindings={false} />);
    expect(out).toContain('<h1 class="ui-page-header__title" aria-describedby="review-term-stage-1"><span data-term="stage-1">Pre-processing</span> review 1</h1>');
    expect(out).toContain('<dt><span data-term="seal">Seal</span></dt>');
    expect(out).toContain('<dt><span data-term="fingerprint">Fingerprint</span></dt>');
    expect(out.indexOf('class="term-list"')).toBeLessThan(out.indexOf('class="review-facts"'));
    // The page's later uses: the state line, a seal's line and its fingerprint.
    expect(firstUseProblems(`${out}<p>Sealed as seal 1 on 15 Nov 2026.</p><p>Fingerprint <code>0a1b</code></p>`)).toEqual([]);
  });

  it('introduces "finding" only when the page lists changed findings; fingerprint only when a seal is listed', () => {
    const props = { name: 'Pre-processing review 1', breadcrumb: [], view };
    const plain = renderToStaticMarkup(<ReviewPageTop {...props} hasSeals={false} changedFindings={false} />);
    expect(plain).not.toContain('data-definition="finding"'); expect(plain).not.toContain('data-definition="fingerprint"');
    const changed = renderToStaticMarkup(<ReviewPageTop {...props} hasSeals changedFindings />);
    expect(changed).toContain('<dt><span data-term="finding">Finding</span></dt>');
    expect(firstUseProblems(`${changed}<p>Findings changed since the last seal (1): </p>`)).toEqual([]);
  });
});

describe('S-16 Open a stage review (reviews/new)', () => {
  const next = { 'pre-processing': 2, 'in-processing': 1, 'post-processing': 1 } as const;

  it('the heading holds "stage review" with its definition under it', () => {
    const out = header(REVIEW_COPY.titles.openReview, [TERM_STAGE_REVIEW]);
    expect(out).toContain('<h1 class="ui-page-header__title" aria-describedby="t-stage-review">Open a <span data-term="stage-review">stage review</span></h1>');
    expect(firstUseProblems(out)).toEqual([]);
  });

  it('the name line marks the stage and its meaning follows it, for the fixed stage and for the chosen one', () => {
    const fixed = renderToStaticMarkup(<OpenReviewForm orgSlug="o" projectId="p" userId="u" fixedStage="post-processing" nextNumbers={next} />);
    expect(fixed).toContain(`<p>${REVIEW_COPY.open.nameLabel} <strong><span data-term="stage-3">Post-processing</span> review 1</strong></p><p class="ui-definition" data-definition="stage-3">${TERM_STAGE_3.definition}</p>`);
    // On the page the heading comes first: it holds "stage review", which the form's button repeats.
    const top = header(REVIEW_COPY.titles.openReview, [TERM_STAGE_REVIEW]);
    expect(firstUseProblems(top + fixed)).toEqual([]);
    const chosen = renderToStaticMarkup(<OpenReviewForm orgSlug="o" projectId="p" userId="u" fixedStage={null} nextNumbers={next} />);
    expect(chosen).toContain('<strong><span data-term="stage-1">Pre-processing</span> review 2</strong></p><p class="ui-definition" data-definition="stage-1">');
    expect(firstUseProblems(top + chosen)).toEqual([]);
  });
});

describe('S-17 the seal step (S7: C 182, C 183)', () => {
  const PREVIEW: SealPreview = {
    byStatus: { done: 1, partly: 0, not_yet: 0, not_applicable: 2 }, byReasonCode: { na_no_personal_data: 2, na_unknown_code: 1 },
    noDecision: ['Q-PP-03'], doneWithoutEvidence: 1, openFindings: 1, openMitigations: 0, enteredByPeople: 1,
    sealer: { name: 'Grace A.', role: 'reviewer' }, rewordedSinceDecision: 0, scopeAnswer: null, evidence: { files: 0, links: 0 },
  };
  const LABELS = { na_no_personal_data: 'No personal data is involved' };
  const P = REVIEW_COPY.sealPage;
  const body = () => renderToStaticMarkup(
    <SealPreviewBody parts={previewParts(PREVIEW, 1, LABELS)} contentLine={null} noDecision={[{ id: 'Q-PP-03', href: '/q', text: 'Is the data current?' }]} />,
  );
  const top = () => header(REVIEW_COPY.titles.seal('Pre-processing review 1'), sealPageTerms('pre-processing').titleTerms, sealPageTerms('pre-processing').moreTerms);

  it('the heading holds "seal" and the stage; finding and mitigation are introduced under it', () => {
    const out = top();
    expect(out).toContain('aria-describedby="t-seal t-stage-1"');
    expect(out).toContain('<dt><span data-term="finding">Finding</span></dt>');
    expect(out).toContain('<dt><span data-term="mitigation">Mitigation</span></dt>');
    expect(firstUseProblems(top() + body())).toEqual([]);
  });

  it('counts the decisions by status in a table, each status beside its definition', () => {
    const out = body();
    expect(out).toContain(`>${P.statusTable.caption}</caption>`);
    for (const [t, n] of [[TERM_DONE, 1], [TERM_PARTLY, 0], [TERM_NOT_YET, 0], [TERM_NOT_APPLICABLE, 2]] as const) {
      expect(out).toMatch(new RegExp(`<th role="rowheader" scope="row"><span data-term="${t.id}">${t.term}</span><p class="ui-definition" data-definition="${t.id}">[^<]+</p></th><td role="cell" class="ui-table__end"><span class="ui-table__cell-label" aria-hidden="true">${P.statusTable.count}</span>${n}</td>`));
    }
    expect(out).not.toContain('Decisions by status:');
  });

  it('counts Not applicable and Not yet by reason in a small table; a code with no label is shown as itself (C11)', () => {
    const out = body();
    expect(out).toContain(`>${P.reasonTable.caption}</caption>`);
    expect(out).toMatch(/<th role="rowheader" scope="row">No personal data is involved<\/th><td[^>]*><span[^>]*>[^<]*<\/span>2<\/td>/);
    expect(out).toMatch(/<th role="rowheader" scope="row">na_unknown_code<\/th>/);
    expect(renderToStaticMarkup(<SealPreviewBody parts={previewParts({ ...PREVIEW, byReasonCode: {} }, 1, LABELS)} contentLine={null} noDecision={[]} />))
      .not.toContain(P.reasonTable.caption);
  });

  it('marks "the personal data question" in the gate answer line, its definition in the same item (B4 I1)', () => {
    const gate = { ...PREVIEW, scopeAnswer: { answer: 'yes' } } as SealPreview;
    const out = renderToStaticMarkup(<SealPreviewBody parts={previewParts(gate, 1, LABELS)} contentLine={null} noDecision={[]} />);
    const T = TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION;
    expect(out).toContain(`<li>Answer to <span data-term="${T.id}">the personal data question</span>: ${REVIEW_COPY.gateWords.yes} <span class="ui-definition" data-definition="${T.id}">${T.definition}</span></li>`);
    expect(firstUseProblems(top() + out)).toEqual([]);
    // With no gate answer the line is not there, and nothing is defined for it.
    expect(body()).not.toContain(`data-definition="${T.id}"`);
  });

  it('keeps the other lines as a list, after the tables, and previewLines still says the same counts as text', () => {
    const out = body();
    expect(out).toContain(`<li>${P.openMitigations(0)}</li>`);
    expect(out.indexOf(P.reasonTable.caption)).toBeLessThan(out.indexOf(P.openMitigations(0)));
    expect(previewLines(PREVIEW, 1, LABELS)).toContain('Decisions by status: Done 1\u00a0· Partly 0\u00a0· Not yet 0\u00a0· Not applicable 2');
  });
});
