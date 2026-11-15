import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { FINDING_NOTE, STATUS_OPTIONS } from '@/lib/decision/copy';
import { EVIDENCE_COPY } from '@/lib/evidence/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { TERM_FINDING } from '@/lib/vocabulary/terms';
import { UI_COPY } from '@/lib/ui/copy';
import { decode, textOf } from '@/__tests__/helpers/markup';

/**
 * The decision card on the question page (the Route rebuild, lane 2 task 1; owner's rulings R2, R3, R8, R9 of 15 November
 * 2026; spec 7.3 and 9.3): one card "Your decision" that holds the saved mark, who decided and entered, the history link,
 * the fields, the evidence, the sentence on what this save will do, Save beside the next question, and More actions.
 * Static markup: hooks run, effects do not, so this is the first markup a browser receives.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }), usePathname: () => '/x' }));

const { DecisionCard } = await import('@/components/decision/DecisionCard');
const { draftFromCurrent } = await import('@/lib/question/draft');

const F = DECISION_FORM_COPY;
const C = F.consequence;

const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you checked whether AI is the best approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'Good practice.', whyAsked: 'y',
  reasonPrompt: 'Name the alternatives you compared and what decided it.',
  evidenceExamples: ['a C-01 alternatives analysis, filled in', 'minutes of the meeting where the choice was made'],
  stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
const V1: DecisionVersionView = {
  id: 'dv1', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'partly', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Theirs', reasonErased: null,
  decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-12', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-10-12T07:42:00.000Z', evidence: [],
};
const V2: DecisionVersionView = { ...V1, id: 'dv2', versionNumber: 2, baseVersionNumber: 1 };
const PANEL: QuestionPanelData = {
  orgSlug: 'acme', projectId: 'p1', projectArchived: false, stage: 'pre-processing', question: QUESTION, runningQuestion: QUESTION,
  position: { index: 1, total: 24, previousId: 'Q-PP-00', nextId: 'Q-PP-02' }, current: null, historyCount: 0, seals: [],
  reasonCodes: [
    { code: 'ny_planned_later', status: 'not_yet', label: 'Planned for later', useWhen: 'The work is planned with a date.', reasonMustSay: 'Say when it is planned.' },
    { code: 'na_other', status: 'not_applicable', label: 'Other reason', useWhen: 'None of the others fits.', reasonMustSay: 'Say why.' },
  ],
  members: [{ userId: 'u-j', name: 'Joseph K.' }], viewer: { userId: 'u-me', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: null, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const NEXT = { questionId: 'Q-PP-02', text: 'Who is affected by the AI system?', href: '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-02', number: 3, total: 24 };
const STAGE = '/orgs/acme/projects/p1/stages/pre-processing';
const HISTORY = '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01/history';

const card = (p: Partial<QuestionPanelData> = {}, o: { next?: typeof NEXT | null; open?: number } = {}) =>
  renderToStaticMarkup(<DecisionCard data={{ ...PANEL, ...p }} next={o.next === undefined ? NEXT : o.next} stageHref={STAGE} openFindingsOnQuestion={o.open ?? 0} />) ?? '';
const words = (h: string) => textOf(h).replace(/\s+/g, ' ');
/** The words of the one consequence line. */
const consequence = (h: string) => {
  const m = /<p[^>]*data-consequence[^>]*>([\s\S]*?)<\/p>/.exec(h);
  expect(m, 'the consequence line').not.toBeNull();
  return words(m![1]);
};
const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('the decision card (R2)', () => {
  it('renders nothing for a person who may not record', () => {
    expect(renderToStaticMarkup(<DecisionCard data={{ ...PANEL, canWrite: false }} next={NEXT} stageHref={STAGE} openFindingsOnQuestion={0} />)).toBe('');
  });

  it('is the whole decision section, headed "Your decision", in the order of the sketch', () => {
    const h = card({ question: { ...QUESTION, type: 'checklist', options: ['A', 'B'] }, current: { ...V2, status: 'not_yet', reasonCode: 'ny_planned_later' }, historyCount: 2,
      viewer: { ...PANEL.viewer, role: 'owner' } });   // an owner may withdraw any current decision, so More actions shows
    expect(h.startsWith('<section data-region="answer-form" aria-labelledby="s12-answer-form"')).toBe(true);
    expect(h).toContain(`<h2 id="s12-answer-form">${F.card.heading}</h2>`);
    expect(h).not.toContain(QUESTION_COPY.headings.current);
    expect(h).not.toContain(QUESTION_COPY.headings.record);
    const at = (needle: string | RegExp) => {
      const i = typeof needle === 'string' ? h.indexOf(needle) : h.search(needle);
      expect(i, String(needle)).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at('id="s12-answer-form"'), at('class="ui-saved'), at('Which of these are in place?'), at(/<legend[^>]*>Status<\/legend>/),
      at('id="decision-reason-code"'), at('id="decision-reason"'), at('id="decision-decided-by"'), at('id="decision-day"'),
      at(/<legend>Evidence<\/legend>/), at('data-consequence'), at('>Save decision</button>'), at(`>${F.card.next(NEXT.text)}`),
      at(`<summary>More actions</summary>`),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('keeps the form a client form with one submit, Save decision', () => {
    const h = card();
    expect(h.match(/type="submit"/g)).toHaveLength(1);
    expect(h).toMatch(/<form[^>]*data-region-form="answer-form"/);
  });
});

describe('the saved mark in the card\'s corner (spec 7.3)', () => {
  it('version 1: saved as version 1, decided on and saved labelled apart, the platform line; not a live region', () => {
    const h = card({ current: V1, historyCount: 1 });
    const mark = h.match(/<div class="ui-saved"[\s\S]*?<\/div>/)![0];
    expect(mark).not.toContain('role="status"');
    expect(mark).not.toContain('aria-live');
    expect(words(mark)).toContain(UI_COPY.saved.title(1));
    expect(words(mark)).toContain(`${UI_COPY.saved.decidedOn} 12 Oct 2026`);
    expect(words(mark)).toContain(`${UI_COPY.saved.savedAt} `);
    expect(words(mark)).toContain(UI_COPY.saved.onPlatform);
    expect(words(mark)).not.toContain('kept in');
  });

  it('version 2: "Version 1 is kept in the history." with its link', () => {
    const h = card({ current: V2, historyCount: 2 });
    expect(words(h)).toContain(UI_COPY.saved.title(2));
    expect(h).toMatch(new RegExp(`${esc(UI_COPY.saved.keptBefore(1))}<a href="${esc(HISTORY)}">${UI_COPY.saved.keptLink}</a>`));
  });

  it('who decided and who entered, and "History: n versions", quietly under the heading', () => {
    const h = card({ current: V2, historyCount: 2 });
    expect(words(h)).toContain('Decided by: Principal investigator (no platform account).');
    expect(words(h)).toMatch(/Entered by: Joseph K\. on 12 Oct 2026 at \d{2}:\d{2} \S+/);
    expect(h).toMatch(new RegExp(`<a href="${esc(HISTORY)}"[^>]*>${esc(QUESTION_COPY.reading.history(2))}</a>`));
  });

  it('a withdrawal as the current version: the withdrawn line, no saved mark', () => {
    const h = card({ current: { ...V2, versionNumber: 3, status: 'withdrawn', withdrawalCode: 'duplicate', decidedBy: null, declaredDate: null }, historyCount: 3 });
    expect(words(h)).toContain(QUESTION_COPY.current.withdrawn('Duplicate'));
    expect(h).not.toContain('ui-saved__title');
    expect(h).toContain(QUESTION_COPY.reading.history(3));
  });

  it('no version: "No decision yet." and no saved mark, no history link', () => {
    const h = card();
    expect(words(h)).toContain(QUESTION_COPY.current.none);
    expect(h).not.toContain('ui-saved__title');
    expect(h).not.toContain('/history');
  });
});

describe('the status choice (R3) and the done mark (R8)', () => {
  it('four short cards in two columns, each the radio, the mark and the word; its sentence kept as the radio\'s description', () => {
    const h = card();
    expect(h).toMatch(/<fieldset class="ui-radio-cards ui-radio-cards--columns-2"[^>]*>\s*<legend[^>]*>Status<\/legend>/);
    for (const o of STATUS_OPTIONS) {
      const radio = h.match(new RegExp(`<input[^>]*id="decision-status-${o.value}"[^>]*>`))?.[0] ?? '';
      expect(radio).toContain(`aria-describedby="decision-status-${o.value}-help"`);
      expect(h).toMatch(new RegExp(`<label class="ui-radio-card__label" for="decision-status-${o.value}">${esc(radio)}<svg class="ui-mark__shape[^"]*"[^>]*aria-hidden="true"[\\s\\S]*?</svg>${esc(o.label)}</label>`));
      expect(h).toContain(`<p class="ui-radio-card__help" id="decision-status-${o.value}-help">${o.help}</p>`);
    }
    // the guiding line moved from the legend to the consequence line
    expect(h).not.toMatch(/<div class="ui-radio-cards__hint"[^>]*>If you choose/);
    expect(h).toContain('decision-fields__choice');
  });

  it('the personal data question: legend Answer, Yes, No and Not sure in the same two-column grid', () => {
    const h = card({ question: { ...QUESTION, id: 'Q-PP-GATE-SENSITIVE', type: 'gate' } });
    expect(h).toMatch(/<fieldset class="ui-radio-cards ui-radio-cards--columns-2"[^>]*>\s*<legend[^>]*>Answer \(required\)<\/legend>/);
    expect([...h.matchAll(/<input[^>]*type="radio"[^>]*value="([a-z_]+)"/g)].map((m) => m[1])).toEqual(['yes', 'no', 'not_sure']);
  });
});

describe('the reason, the main reason and Decided by', () => {
  it('ruling (a): the label is "Reason" and its hint is the question\'s own prompt, with the count', () => {
    const h = card();
    expect(h).toMatch(/<label[^>]*for="decision-reason"[^>]*>Reason/);
    expect(h).toContain(`<p id="decision-reason-help" class="decision-fields__help">${QUESTION.reasonPrompt}</p>`);
    expect(h).toMatch(/<textarea[^>]*aria-describedby="decision-reason-count decision-reason-help"/);
    expect(h).not.toContain('Say what is in place, where it is recorded, and what is missing.');
  });

  it('a chosen main reason shows when to use it under the select and adds what the reason must say to the hint', () => {
    const h = card({ current: { ...V2, status: 'not_yet', reasonCode: 'ny_planned_later' } });
    expect(h).toMatch(/<select[^>]*id="decision-reason-code"[\s\S]*?<\/select>[\s\S]*?<p id="decision-reason-code-use" class="decision-fields__help">The work is planned with a date\.<\/p>/);
    expect(h).toContain(`<p id="decision-reason-help" class="decision-fields__help">${QUESTION.reasonPrompt} Say when it is planned.</p>`);
  });

  it('owner OQ1 (a): Decided by starts empty on a first decision, with "Choose one" first and chosen', () => {
    expect(draftFromCurrent(PANEL).decidedBy).toBeNull();
    const h = card();
    const select = h.match(/<select[^>]*id="decision-decided-by"[\s\S]*?<\/select>/)![0];
    expect(select).toMatch(/^<select[^>]*>\s*<option value="" selected="">Choose one<\/option>\s*<option value="member:u-me">You \(Amina N\.\)<\/option>/);
  });

  it('after a withdrawal Decided by is still the viewer; a re-decision keeps the recorded decider', () => {
    expect(draftFromCurrent({ ...PANEL, current: { ...V2, status: 'withdrawn', withdrawalCode: 'duplicate', decidedBy: null } }).decidedBy).toEqual({ kind: 'member', userId: 'u-me' });
    expect(draftFromCurrent({ ...PANEL, current: V2 }).decidedBy).toEqual({ kind: 'outside_role', role: 'principal_investigator' });
  });

  it('Decided by and Decided on share one row; the date keeps three boxes and Today', () => {
    const h = card();
    expect(h).toMatch(/<div class="decision-fields__row">[\s\S]*id="decision-decided-by"[\s\S]*<legend class="ui-date__legend">Decided on/);
    expect([...h.matchAll(/<input[^>]*inputmode="numeric"/gi)]).toHaveLength(3);
    expect(h).toMatch(/<button[^>]*>Today<\/button>/);
  });
});

describe('the evidence (spec 9.3 item 5)', () => {
  it('the question\'s own examples, the stored sentence verbatim, the private-data line, and "None yet." with nothing attached', () => {
    const h = card();
    const ev = h.match(/<fieldset class="evidence-block">[\s\S]*?<\/fieldset>/)![0];
    for (const e of QUESTION.evidenceExamples) expect(ev).toContain(`<li>${e}</li>`);
    expect(decode(ev)).toContain('Your file is stored as it is. The platform checks its type and records a fingerprint. It does not open or run the file.');
    expect(decode(ev)).toContain(EVIDENCE_COPY.help.keep);
    expect(ev).toContain(EVIDENCE_COPY.noneYet);
    // the two controls stay one press away (the protected flows press "Add a link" and set the file input directly)
    expect(ev).toMatch(/>Add a file<\/button>/);
    expect(ev).toMatch(/aria-expanded="false"[^>]*>Add a link<\/button>/);
  });
});

describe('the consequence line: what this save will do, and its version (R2)', () => {
  const line = (p: Partial<QuestionPanelData>, open = 0) => consequence(card(p, { open }));

  it('the owner\'s example, verbatim: Partly with an open finding on version 1', () => {
    expect(line({ current: V1, historyCount: 1 }, 1)).toContain('Saving ‘Partly’ keeps a finding open for this question until your team closes it. This save becomes version 2.');
  });

  it('no status chosen keeps the meaning of the old note; a first decision becomes version 1', () => {
    expect(line({})).toContain(`${FINDING_NOTE} ${C.version(1)}`);
  });

  it('every status, with and without an open finding, ends with this save\'s version', () => {
    const cases: Array<[string, number, string]> = [
      ['done', 0, C.raisesNone('Done')], ['done', 1, C.closesNot('Done')],
      ['partly', 0, C.raises('Partly')], ['partly', 1, C.keepsOpen('Partly')],
      ['not_yet', 0, C.raises('Not yet')], ['not_yet', 1, C.keepsOpen('Not yet')],
      ['not_applicable', 0, C.raisesNone('Not applicable')], ['not_applicable', 1, C.closesNot('Not applicable')],
    ];
    for (const [status, open, sentence] of cases) {
      expect(line({ current: { ...V2, status: status as never } }, open), `${status} ${open}`).toContain(`${sentence} ${C.version(3)}`);
    }
  });

  it('"finding" is defined beside its first use; a sentence without it has no definition', () => {
    const h = card({ current: V2 }, { open: 1 });
    expect(h).toMatch(/data-consequence[\s\S]*data-definition="finding"/);
    expect(decode(h)).toContain(TERM_FINDING.definition);
    const none = card({ current: { ...V2, status: 'done' } });
    expect(none).not.toContain('data-definition="finding"');
  });

  it('the personal data question: what Yes, No and Not sure switch on or off', () => {
    const gate = { ...QUESTION, id: 'Q-PP-GATE-SENSITIVE', type: 'gate' } as LoadedQuestion;
    for (const a of ['yes', 'no', 'not_sure'] as const) {
      expect(line({ question: gate, runningQuestion: gate, current: { ...V2, status: null, scopeAnswer: a } })).toBe(`${C.scope[a]} ${C.version(3)}`);
    }
    expect(line({ question: gate, runningQuestion: gate })).toBe(C.version(1));
  });
});

describe('Save beside the next question (R2, R9)', () => {
  it('"Next: <question words>" links to the next question, with "Question n of N" under it, inside the save bar', () => {
    const h = card();
    const bar = h.match(/<div class="decision-save-bar"[\s\S]*$/)![0];
    expect(bar).toMatch(new RegExp(`<a[^>]*href="${esc(NEXT.href)}"[^>]*><span class="decision-next__words">${esc(F.card.next(NEXT.text))}</span><span class="decision-next__position">${esc(F.card.position(3, 24))}</span></a>`));
    expect(bar.indexOf('>Save decision</button>')).toBeLessThan(bar.indexOf(F.card.next(NEXT.text)));
  });

  it('on the stage\'s last question: the last-question line and All questions', () => {
    const h = card({}, { next: null });
    expect(h).toContain(QUESTION_COPY.foot.last);
    expect(h).toMatch(new RegExp(`<a[^>]*href="${esc(STAGE)}"[^>]*>${QUESTION_COPY.nav.allQuestions}</a>`));
    expect(h).not.toContain('Next: ');
  });
});
