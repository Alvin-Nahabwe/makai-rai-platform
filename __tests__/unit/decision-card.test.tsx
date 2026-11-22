import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { FINDING_NOTE, STATUS_OPTIONS } from '@/lib/decision/copy';
import { textErasedLine } from '@/lib/documents/copy';
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

/** `open` is the question's open shortfall finding (data.openFinding), the one a save acts on; `all` the seam's count of every open finding. */
/**
 * The line for an answer the person changed (here the reason), on the panel `p` with `open` shortfall findings: the version
 * line is shown only while the answer differs from the saved version (coordinator, T3c item 7).
 */
const changed = async (p: Partial<QuestionPanelData>, open = 0): Promise<string> => {
  const { consequenceOf } = await import('@/components/decision/DecisionForm');
  const data = { ...PANEL, ...(open > 0 ? { openFinding: { findingId: 'f1' } } : {}), ...p };
  return consequenceOf({ ...draftFromCurrent(data), reason: 'Changed since the saved version.' }, data, data.current?.versionNumber ?? null).text;
};
const card = (p: Partial<QuestionPanelData> = {}, o: { next?: typeof NEXT | null; open?: number; all?: number } = {}) =>
  renderToStaticMarkup(<DecisionCard data={{ ...PANEL, ...((o.open ?? 0) > 0 ? { openFinding: { findingId: 'f1' } } : {}), ...p }} next={o.next === undefined ? NEXT : o.next} stageHref={STAGE} openFindingsOnQuestion={o.all ?? o.open ?? 0} />) ?? '';
const words = (h: string) => textOf(h).replace(/\s+/g, ' ');
/** The words of the one consequence line. */
const consequence = (h: string) => {
  const m = /<p[^>]*data-consequence[^>]*>([\s\S]*?)<\/p>/.exec(h);
  expect(m, 'the consequence line').not.toBeNull();
  // the words alone: a term's (i) holds its button and its definition (T3c item 10b)
  return words(m![1].replace(/<span class="ui-term-tip">[\s\S]*?<\/span><\/span><\/span>/g, ''));
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
    expect(h).toMatch(new RegExp(`${esc(UI_COPY.saved.keptBefore(1))}<a [^>]*href="${esc(HISTORY)}"[^>]*>${UI_COPY.saved.keptLink}</a>`));
  });

  it('D1: the header is the heading and one line in the corner, "Saved as version N · <date>"; who decided, who entered, the dates, the platform line and "History: n versions" are at the foot, after Save and before More', () => {
    const h = card({ current: V2, historyCount: 2, viewer: { ...PANEL.viewer, role: 'owner' } });
    const head = h.match(/<div class="decision-card__head">[\s\S]*?<\/div><\/div>/)![0];
    expect(words(head)).toBe(`${F.card.heading}${F.card.savedAs(2)}12 Oct 2026 UTC`);
    const foot = h.match(/<div class="decision-card__meta">[\s\S]*?<\/div><div class="decision-card__more">/)![0];
    expect(words(foot)).toContain(`${UI_COPY.saved.decidedOn} 12 Oct 2026 \u00b7 ${UI_COPY.saved.savedAt} 12 Oct 2026, 07:42 UTC`);
    expect(words(foot)).toContain(`${UI_COPY.saved.onPlatform} ${UI_COPY.saved.keptBefore(1)}${UI_COPY.saved.keptLink}.`);
    // T3 item 9 (coordinator's ruling): the entered time is East Africa time, with its zone, as lane 1's reading card.
    expect(words(foot)).toContain('Decided by: Principal investigator (no platform account). Entered by: Joseph K. on 12 Oct 2026, 10:42 EAT.');
    expect(foot).toMatch(/<time dateTime="2026-10-12T07:42:00.000Z">/);
    expect(foot).toMatch(new RegExp(`<a [^>]*href="${esc(HISTORY)}"[^>]*>${esc(QUESTION_COPY.reading.history(2))}</a>`));
    expect(h.indexOf('>Save decision</button>')).toBeLessThan(h.indexOf('class="decision-card__meta"'));
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
      // T3c item 10a (lane 6's first-use rule): the word is the status's term, and its sentence the status's definition
      const term = { done: 'done', partly: 'partly', not_yet: 'not-yet', not_applicable: 'not-applicable' }[o.value];
      expect(h).toMatch(new RegExp(`<label class="ui-radio-card__label" for="decision-status-${o.value}">${esc(radio)}<svg class="ui-mark__shape[^"]*"[^>]*aria-hidden="true"[\\s\\S]*?</svg><span data-term="${term}">${esc(o.label)}</span></label>`));
      expect(h).toContain(`<p class="ui-radio-card__help" id="decision-status-${o.value}-help" data-definition="${term}">${o.help}</p>`);
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
  it('D4: one line, "Evidence", "None yet." and the two add buttons; the examples visible; the private-data line; the types and the stored sentence in a closed "Accepted files"', () => {
    const h = card();
    const ev = h.match(/<fieldset class="evidence-block evidence-block--card">[\s\S]*?<\/fieldset>/)![0];
    expect(ev).toMatch(/^<fieldset[^>]*><legend>Evidence<\/legend><div class="evidence-block__add"><p class="evidence-block__none">None yet\.<\/p>/);
    const examples = ev.match(/<div class="evidence-block__examples">[\s\S]*?<\/div>/)![0];
    for (const e of QUESTION.evidenceExamples) expect(examples).toContain(`<li>${e}</li>`);
    expect(examples).not.toMatch(/<details/);
    expect(decode(ev)).toContain(`<p>${EVIDENCE_COPY.help.keep}</p><details class="evidence-block__more"><summary>${EVIDENCE_COPY.acceptedFiles}</summary>`);
    const more = decode(ev.match(/<details[\s\S]*?<\/details>/)![0]);
    expect(more).not.toMatch(/<details[^>]*\bopen/);
    expect(more).toContain(EVIDENCE_COPY.help.types);
    expect(more).toContain('Your file is stored as it is. The platform checks its type and records a fingerprint. It does not open or run the file.');
    // the two controls stay one press away (the protected flows press "Add a link" and set the file input directly)
    expect(ev).toMatch(/>Add a file<\/button>/);
    expect(ev).toMatch(/aria-expanded="false"[^>]*>Add a link<\/button>/);
  });
});

describe('the consequence line: what this save will do, and its version (R2)', () => {
  const line = (p: Partial<QuestionPanelData>, open = 0) => consequence(card(p, { open }));

  it('the owner\'s example, verbatim: Partly with an open finding on version 1, once the answer differs from it', async () => {
    expect(await changed({ current: V1, historyCount: 1 }, 1)).toBe('Saving ‘Partly’ keeps a finding open for this question until your team closes it. This save becomes version 2.');
  });

  it('no status chosen keeps the meaning of the old note; a first decision becomes version 1', () => {
    expect(line({})).toContain(`${FINDING_NOTE} ${C.version(1)}`);
  });

  it('every status, with and without an open finding, ends with this save\'s version once the answer differs', async () => {
    const cases: Array<[string, number, string]> = [
      ['done', 0, C.raisesNone('Done')], ['done', 1, C.closesNot('Done')],
      ['partly', 0, C.raises('Partly')], ['partly', 1, C.keepsOpen('Partly')],
      ['not_yet', 0, C.raises('Not yet')], ['not_yet', 1, C.keepsOpen('Not yet')],
      ['not_applicable', 0, C.raisesNone('Not applicable')], ['not_applicable', 1, C.closesNot('Not applicable')],
    ];
    for (const [status, open, sentence] of cases) {
      expect(await changed({ current: { ...V2, status: status as never } }, open), `${status} ${open}`).toBe(`${sentence} ${C.version(3)}`);
      expect(line({ current: { ...V2, status: status as never } }, open), `${status} ${open} unchanged`).toBe(sentence);
    }
  });

  it('"finding" is defined beside its first use; a sentence without it has no definition', () => {
    const h = card({ current: V2 }, { open: 1 });
    expect(h).toMatch(/data-consequence[\s\S]*data-definition="finding"/);
    expect(decode(h)).toContain(TERM_FINDING.definition);
    const none = card({ current: { ...V2, status: 'done' } });
    expect(none).not.toContain('data-definition="finding"');
  });

  it('the personal data question: what Yes, No and Not sure switch on or off', async () => {
    const gate = { ...QUESTION, id: 'Q-PP-GATE-SENSITIVE', type: 'gate' } as LoadedQuestion;
    for (const a of ['yes', 'no', 'not_sure'] as const) {
      expect(await changed({ question: gate, runningQuestion: gate, current: { ...V2, status: null, scopeAnswer: a } })).toBe(`${C.scope[a]} ${C.version(3)}`);
      expect(line({ question: gate, runningQuestion: gate, current: { ...V2, status: null, scopeAnswer: a } })).toBe(C.scope[a]);
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

  it('design G3: a saved last question goes to the stage\'s end screen; any other saved question stays', () => {
    const clean = { statusId: 'M-03', leftOut: [] as string[], typedDuringSave: false };
    expect(endHrefAfterSave(null, STAGE, clean)).toBe(`${STAGE}/end`);
    expect(endHrefAfterSave(NEXT, STAGE, clean)).toBeNull();
    expect(endHrefAfterSave(null, undefined, clean)).toBeNull();
  });

  it('design G3, ruling on risk b: the push happens only on a clean Saved; a message the person must see keeps them on the question', () => {
    // "Saved without <file>... save again" (M-03 with a left-out file), text typed during the save (CR-1, UX-25), "already saved" (M-04).
    expect(endHrefAfterSave(null, STAGE, { statusId: 'M-03', leftOut: ['a.pdf'], typedDuringSave: false })).toBeNull();
    expect(endHrefAfterSave(null, STAGE, { statusId: 'M-03', leftOut: [], typedDuringSave: true })).toBeNull();
    expect(endHrefAfterSave(null, STAGE, { statusId: 'M-04', leftOut: [], typedDuringSave: false })).toBeNull();
  });

  it('on the stage\'s last question: the last-question line and All questions', () => {
    const h = card({}, { next: null });
    expect(h).toContain(QUESTION_COPY.foot.last);
    expect(h).toMatch(new RegExp(`<a[^>]*href="${esc(STAGE)}"[^>]*>${QUESTION_COPY.nav.allQuestions}</a>`));
    // Design G3: the last question's way on also reaches the stage's end screen.
    expect(h).toMatch(new RegExp(`<a[^>]*href="${esc(STAGE)}/end"[^>]*>${QUESTION_COPY.end.link}</a>`));
    expect(h).not.toContain('Next: ');
  });
});

describe('review round 1', () => {
  it('A-I1: a current reason erased on the organisation\'s instruction is said beside the empty Reason box, and the box names it', () => {
    const h = card({ current: { ...V2, reason: null, reasonErased: { erasedOn: '2026-11-01' } as never } });
    expect(decode(h)).toContain(`<p id="decision-reason-erased" class="decision-fields__help">${textErasedLine('2026-11-01')}</p>`);
    expect(h).toMatch(/<textarea[^>]*aria-describedby="decision-reason-count decision-reason-help decision-reason-erased"/);
    expect(card({ current: V2 })).not.toContain('decision-reason-erased');
  });

  it('A-I2: "None yet." is not said while the form keeps evidence the block cannot name', async () => {
    const { EvidenceBlockView } = await import('@/components/evidence/EvidenceBlockView');
    const view = (keptCount: number) => renderToStaticMarkup(
      <EvidenceBlockView orgSlug="acme" idBase="e" items={[]} added={[]} uploads={[]} notUploaded={[]} disabled={false}
        linkFormOpen={false} linkUrl="" linkLabel="" linkError={null} decisionCard keptCount={keptCount} />);
    expect(view(0)).toContain(EVIDENCE_COPY.noneYet);
    expect(view(1)).not.toContain(EVIDENCE_COPY.noneYet);
  });

  it('B-I2: the sentence reads the open shortfall finding a save acts on, not the count of every open finding', () => {
    // A team finding open on the question (all: 1) and no shortfall finding: Partly raises one.
    expect(consequence(card({ current: V2 }, { all: 1 }))).toContain(C.raises('Partly'));
    expect(consequence(card({ current: V2 }, { open: 1 }))).toContain(C.keepsOpen('Partly'));
  });

  it('A-minor B-M1: the version is one above the newer of the form\'s base and the version on the page', async () => {
    const { consequenceOf } = await import('@/components/decision/DecisionForm');
    const data = { ...PANEL, current: V2 };
    const typed = { ...draftFromCurrent(data), reason: 'Typed on version 1.' };
    // After a refresh brought version 2 while the person had typed on version 1, the line and the corner agree.
    expect(consequenceOf(typed, data, 1).text).toContain(C.version(3));
    expect(consequenceOf(typed, data, 2).text).toContain(C.version(3));
    expect(consequenceOf(draftFromCurrent(PANEL), PANEL, null).text).toContain(C.version(1));
  });

  it('B-M3: "Your answer" with no decider chosen says so, never "Decided by: , <date>"', async () => {
    const { ConflictView } = await import('@/components/decision/ConflictView');
    const h = renderToStaticMarkup(<ConflictView current={V1} mine={{ ...draftFromCurrent(PANEL), date: { day: '14', month: '11', year: '2026' } }}
      viewerId="u-me" mineDecidedBy="" onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(decode(h)).toContain(`${F.conflict.notChosen}, 14 Nov 2026`);
    expect(decode(h)).not.toMatch(/>, 14 Nov 2026</);
  });

  it('A-minor: the main reason\'s line on when to use it describes the select', () => {
    const h = card({ current: { ...V2, status: 'not_yet', reasonCode: 'ny_planned_later' } });
    expect(h).toMatch(/<select[^>]*id="decision-reason-code"[^>]*aria-describedby="decision-reason-code-use"/);
    expect(card({ current: { ...V2, status: 'not_yet', reasonCode: null } })).not.toContain('decision-reason-code-use');
  });

  it('D2 D3: the reason box is four rows; the date\'s hint sits under the row, one line, and every box names it', () => {
    const h = card();
    expect(h).toMatch(/<textarea[^>]*id="decision-reason"[^>]*rows="4"/);
    expect(h).toMatch(/<\/fieldset><\/div><p id="decision-date-hint" class="decision-fields__date-hint">/);
    for (const part of ['day', 'month', 'year']) expect(h).toMatch(new RegExp(`<input[^>]*id="decision-${part}"[^>]*aria-describedby="decision-date-hint"`));
  });
});

describe('T3a: the card\'s finish (owner\'s sentence, design must-fix and minors, review round 2, routed items)', () => {
  const css = (p: string) => readFileSync(p, 'utf8');

  it('item 1: Partly and Not yet with no open finding say the owner\'s sentence, exactly (its 14:30 words), then the version', async () => {
    const owner = (s: string) => `Saving ‘${s}’ raises a finding for this question, unless its last finding was closed as an accepted risk at this level or a worse one and no version since was Done or Not applicable.`;
    expect(await changed({ current: V2 })).toBe(`${owner('Partly')} ${C.version(3)}`);
    expect(await changed({ current: { ...V2, status: 'not_yet' } })).toBe(`${owner('Not yet')} ${C.version(3)}`);
    expect(consequence(card({ current: V2 }))).toBe(owner('Partly'));
  });

  it('M2: Decided by keeps at least 16rem beside Decided on, and the two stack when the card is narrower than both', () => {
    const fields = css('components/decision/DecisionFields.css');
    expect(fields).not.toMatch(/container-type:\s*inline-size/);
    // The row wraps by its own width: 16rem + (26rem - the gap) + the gap = 42rem, at any default font size (D-419).
    expect(fields).not.toMatch(/@media[^{]*width[^{]*\{\s*\.decision-fields__row/);
    expect(fields).toMatch(/\.decision-fields__row\s*\{[^}]*display:\s*flex;[^}]*flex-wrap:\s*wrap;[^}]*column-gap:\s*var\(--space-4\);/);
    expect(fields).toMatch(/\.decision-fields__row > \.ui-field\s*\{[^}]*flex:\s*1 1 16rem;[^}]*min-inline-size:\s*0;/);
    expect(fields).toMatch(/\.decision-fields__row > \.ui-date\s*\{[^}]*flex:\s*1\.5 1 calc\(26rem - var\(--space-4\)\);[^}]*min-inline-size:\s*0;/);
    expect(fields).not.toMatch(/minmax\(11rem/);
  });

  it('M3: the two "Same date as" shortcuts are quiet single-line controls, still buttons with their names', () => {
    const lastOwn = '2026-11-01';
    const h = card({ current: V2, lastOwnSaveDate: lastOwn as never });
    expect(h).toMatch(new RegExp(`<button class="ui-button ui-button--secondary ui-button--compact" type="button">${esc(F.sameAsMyLast('1 Nov 2026'))}</button>`));
    expect(h).toMatch(new RegExp(`<button class="ui-button ui-button--secondary ui-button--compact" type="button">${esc(F.sameAsCurrent('12 Oct 2026'))}</button>`));
    // Today stays the date's one bordered button; every button after it (the shortcuts) is drawn quiet: no fill, no border,
    // the link colour, underlined, small type.
    const quiet = /\.decision-fields \.ui-date__actions > \.ui-button ~ \.ui-button\s*\{([^}]*)\}/.exec(css('components/decision/DecisionFields.css'))?.[1] ?? '';
    for (const rule of [/border-color:\s*transparent/, /background-color:\s*transparent/, /color:\s*var\(--color-link\)/, /text-decoration:\s*underline/, /font-size:\s*var\(--font-size-small\)/]) expect(quiet).toMatch(rule);
  });

  it('M4: the next question\'s words show an ellipsis when cut, and the phone keeps "Question n of N" visible in small type', () => {
    const form = css('components/decision/DecisionForm.css');
    const words = /\.decision-next__words\s*\{([^}]*)\}/.exec(form)?.[1] ?? '';
    expect(words).toMatch(/line-clamp:\s*2/);
    expect(words).toMatch(/text-overflow:\s*ellipsis/);
    // Chromium draws no ellipsis on an end-aligned clamped line that ends on a whole word: start-aligned in a box pushed to the end.
    expect(words).toMatch(/text-align:\s*start/);
    expect(words).toMatch(/margin-inline-start:\s*auto/);
    expect(form).not.toMatch(/\.decision-next__position\s*\{\s*display:\s*none/);
    expect(form).toMatch(/@media \(max-width: 768px\)[\s\S]*\.decision-next__words\s*\{[^}]*white-space:\s*nowrap/);
    // The whole text stays the link's name: the words and the position, never cut in the markup.
    const link = card().match(/<a class="decision-next"[^>]*>([\s\S]*?)<\/a>/)![1];
    expect(words.length).toBeGreaterThan(0);
    expect(textOf(link)).toBe(`${F.card.next(NEXT.text)}${F.card.position(3, 24)}`);
  });

  it('m1: Save is 48 px high with 24 px each side, in the card\'s own stylesheet', () => {
    const rule = /\.decision-card \.decision-save-bar__row \.ui-button--primary\s*\{([^}]*)\}/.exec(css('components/decision/DecisionCard.css'))?.[1] ?? '';
    expect(rule).toMatch(/min-height:\s*48px/);
    expect(rule).toMatch(/padding-inline:\s*var\(--space-6\)/);
  });

  it('m3: "(required)" is in the label\'s own weight and ink after every label of the card, as after "Answer"', () => {
    const rule = /\.decision-fields \.ui-field__required\s*\{([^}]*)\}/.exec(css('components/decision/DecisionFields.css'))?.[1] ?? '';
    expect(rule).toMatch(/font-weight:\s*var\(--font-weight-bold\)/);
    expect(rule).toMatch(/color:\s*var\(--color-ink\)/);
  });

  it('m4: the corner\'s saved shape is Done\'s mark (the filled green disc with its check), not the outline check', () => {
    const head = card({ current: V2, historyCount: 2 }).match(/<div class="decision-card__head">[\s\S]*?<\/div><\/div>/)![0];
    // The kit's done geometry, in classes of its own: a saved shape, not a status mark the no-score checks would hold to ink.
    expect(head).toMatch(/<svg class="decision-card__saved-svg"[^>]*aria-hidden="true"[^>]*><circle class="decision-card__saved-disc" cx="12" cy="12" r="9"><\/circle><path class="decision-card__saved-check" d="M8 12.5l2.7 2.7L16 9.8"/);
    expect(head).not.toContain('ui-mark__shape');
    const css = readFileSync('components/decision/DecisionCard.css', 'utf8');
    expect(css).toMatch(/\.decision-card__saved-disc\s*\{\s*fill:\s*var\(--color-saved\);/);
    expect(css).toMatch(/\.decision-card__saved-check\s*\{\s*stroke:\s*var\(--color-surface\);/);
    expect(head).not.toContain('class="ui-icon"');
    expect(words(head)).toBe(`${F.card.heading}${F.card.savedAs(2)}12 Oct 2026 UTC`);
  });

  it('A N-1: the accepted types line has its own id, and the add buttons and the file input name it directly', () => {
    const ev = card().match(/<fieldset class="evidence-block evidence-block--card">[\s\S]*?<\/fieldset>/)![0];
    const types = /<p id="([^"]+)" class="evidence-block__types">([^<]*)<\/p>/.exec(ev);
    expect(types?.[2]).toBe(EVIDENCE_COPY.help.types);
    const help = /<div id="([^"]+)" class="evidence-block__help">/.exec(ev)![1];
    for (const control of [/<button[^>]*aria-describedby="([^"]+)"[^>]*>Add a file<\/button>/, /<button[^>]*aria-describedby="([^"]+)"[^>]*>Add a link<\/button>/, /<input[^>]*type="file"[^>]*aria-describedby="([^"]+)"/]) {
      expect(control.exec(ev)?.[1]).toBe(`${help} ${types![1]}`);
    }
    expect(decode(ev)).toContain(`<summary>${EVIDENCE_COPY.acceptedFiles}</summary>`);
  });

  it('item 7: the seal marker of the current version sits in the card\'s foot, below the Save row', () => {
    const h = card({ current: V2, historyCount: 2, seals: [{ sealId: 's1', sealNumber: 2, reviewName: 'Ethics board' }] as never });
    const marker = h.indexOf('class="seal-markers"');
    expect(marker).toBeGreaterThan(h.indexOf('>Save decision</button>'));
    expect(marker).toBeGreaterThan(h.indexOf('class="decision-card__meta"'));
    expect(card({ current: V2 })).not.toContain('seal-markers');
  });

  it('item 7: the phone\'s saved mark carries data-decision-version', () => {
    expect(card({ current: V2, historyCount: 2 })).toMatch(/<div class="ui-saved" data-decision-version="2">/);
  });

  it('item 9: "Entered by" is in East Africa time and names its zone; the saved time beside it is the reader\'s and names its zone too', () => {
    const h = card({ current: V2, historyCount: 2 });
    const foot = h.match(/<div class="decision-card__meta">[\s\S]*?<\/div><div class="decision-card__more">/)![0];
    // 07:42 UTC is 10:42 in Kampala; the reader's zone is UTC until hydration, and the server render says so.
    expect(words(foot)).toContain('Entered by: Joseph K. on 12 Oct 2026, 10:42 EAT.');
    expect(words(foot)).toContain(`${UI_COPY.saved.savedAt} 12 Oct 2026, 07:42 UTC`);
    const mark = h.match(/<div class="ui-saved"[\s\S]*?<\/div>/)![0];
    expect(words(mark)).toContain(`${UI_COPY.saved.savedAt} 12 Oct 2026, 07:42 UTC`);
  });
});

describe('T3a: the history list (routed items 7 and 9)', () => {
  it('T3c item 10d: the first seal marker on the history page defines its terms; later ones are plain', async () => {
    const { DecisionHistoryList } = await import('@/components/decision/DecisionHistoryList');
    const seal = (n: number) => [{ sealId: `s${n}`, sealNumber: n, reviewName: 'Pre-processing review 1' }] as never;
    const h = renderToStaticMarkup(<DecisionHistoryList orgSlug="acme" entries={[{ version: V2, wording: null, seals: [] }, { version: V1, wording: null, seals: seal(1) }, { version: { ...V1, id: 'dv0' }, wording: null, seals: seal(2) }]} />);
    expect(h.match(/data-definition="seal"/g)).toHaveLength(1);
    expect(h.indexOf('data-definition="seal"')).toBeLessThan(h.indexOf('data-version-number="1"') + 2000);
    expect(h.indexOf('data-definition="seal"')).toBeGreaterThan(h.indexOf('data-version-number="1"'));
  });

  it('the version line carries data-decision-version; "Entered by" is in East Africa time with its zone', async () => {
    const { DecisionHistoryList } = await import('@/components/decision/DecisionHistoryList');
    const h = renderToStaticMarkup(<DecisionHistoryList orgSlug="acme" entries={[{ version: V2, wording: null, seals: [] }]} />);
    expect(h).toMatch(/<h2[^>]*data-decision-version="2"[^>]*>Version 2<\/h2>/);
    expect(words(h)).toContain('Joseph K., 12 Oct 2026 10:42 EAT');
  });
});

const { saveControlIsRetry, WaitLines, NextWay, endHrefAfterSave } = await import('@/components/decision/DecisionForm');
const { SaveStatus } = await import('@/components/decision/SaveStatus');
const { toSaveBody } = await import('@/lib/question/draft');
const { requestIdFor } = await import('@/lib/client/retrySafeWrite');

describe('T3b: one Save/Retry control, the unsaved line, the way on during a save, the wait card, the raise link', () => {
  const value = { ...draftFromCurrent(PANEL), status: 'done' as const, reason: 'Compared it.' };
  const body = toSaveBody(value, PANEL, null) as unknown as Record<string, unknown>;
  const sent = requestIdFor({ requestId: null, sentBody: null }, body, () => 'r1').state;
  const failed = { id: 'M-05' as const, text: 'Not saved.', live: 'assertive' as const, next: 'retry' as const };
  const base = { retry: sent, body, status: failed, restoredPressed: false, saving: false, retrying: false };

  it('C4: Retry exactly while the field holds the answer whose request failed and a retry is offered (or a pressed draft was restored)', () => {
    expect(saveControlIsRetry(base)).toBe(true);
    expect(saveControlIsRetry({ ...base, status: null, restoredPressed: true })).toBe(true);
  });
  it('C4: Save decision after an edit, with no request, after a refusal that offers no retry, or with no press restored', () => {
    const edited = toSaveBody({ ...value, reason: 'Edited after the failure' }, PANEL, null) as unknown as Record<string, unknown>;
    expect(saveControlIsRetry({ ...base, body: edited })).toBe(false);
    expect(saveControlIsRetry({ ...base, retry: { requestId: null, sentBody: null } })).toBe(false);
    expect(saveControlIsRetry({ ...base, status: { ...failed, id: 'M-09', next: 'none' } })).toBe(false);
    expect(saveControlIsRetry({ ...base, status: null })).toBe(false);
  });
  it('C4 D-398 item 4: a pressed Retry keeps its label while its request is out; a Save keeps "Save decision"', () => {
    expect(saveControlIsRetry({ ...base, status: { id: 'M-01', text: 'Saving...', live: 'polite', next: 'none' }, saving: true, retrying: true })).toBe(true);
    expect(saveControlIsRetry({ ...base, saving: true, retrying: false })).toBe(false);
  });
  it('C4: the card has exactly one submit control, and no separate Retry button, in its first markup', () => {
    const h = card();
    expect(h.match(/type="submit"/g)).toHaveLength(1);
    expect(h).toMatch(/<button[^>]*type="submit"[^>]*>Save decision<\/button>/);
    expect(h).not.toMatch(/>Retry<\/button>/);
  });

  it('C7: the unsaved line is the only text of an always-present polite, atomic live span; one role=status in .save-status', () => {
    const shown = renderToStaticMarkup(<SaveStatus status={null} draftSavedAt="2026-10-12T07:43:00.000Z" storageUnavailable={false} />);
    expect(shown).toMatch(new RegExp(`<span aria-live="polite" aria-atomic="true"[^>]*>${esc(F.unsaved)}</span>`));
    expect(shown.match(/role="status"/g)).toHaveLength(1);
    const none = renderToStaticMarkup(<SaveStatus status={null} draftSavedAt={null} storageUnavailable={false} />);
    expect(none).toMatch(/<span aria-live="polite" aria-atomic="true"[^>]*><\/span>/);
    expect(none.match(/role="status"/g)).toHaveLength(1);
  });

  it('B-I1: while a Save waits or is out, the way on is the same words as text, with no link', () => {
    const held = renderToStaticMarkup(<NextWay next={NEXT} stageHref={STAGE} held />);
    expect(held).not.toMatch(/<a[\s>]/);
    expect(held).not.toContain('href=');
    expect(words(held)).toBe(`${F.card.next(NEXT.text)}${F.card.position(3, 24)}`);
    expect(held).toContain('decision-next--held');
    const live = renderToStaticMarkup(<NextWay next={NEXT} stageHref={STAGE} held={false} />);
    expect(live).toMatch(new RegExp(`<a[^>]*href="${esc(NEXT.href)}"`));
  });

  it('UX-30 (owner, 14:30): files still uploading share "Waiting for … to finish uploading."; each failed or refused file says it did not upload and what to do', () => {
    const both = renderToStaticMarkup(<WaitLines uploading={['a.pdf', 'c.pdf']} failed={['b.pdf', 'd.pdf']} />);
    expect(both.match(/<p>[\s\S]*?<\/p>/g)!.map(words)).toEqual([
      'Waiting for a.pdf, c.pdf to finish uploading.',
      'b.pdf did not upload. Retry it, remove it, or save without it.',
      'd.pdf did not upload. Retry it, remove it, or save without it.',
    ]);
    expect(words(renderToStaticMarkup(<WaitLines uploading={[]} failed={['b.pdf']} />))).toBe('b.pdf did not upload. Retry it, remove it, or save without it.');
    expect(renderToStaticMarkup(<WaitLines uploading={[]} failed={['b.pdf']} />)).toMatch(/<bdi>b\.pdf<\/bdi>/);
    expect(renderToStaticMarkup(<WaitLines uploading={['a.pdf']} failed={[]} />)).toMatch(/<bdi>a\.pdf<\/bdi>/);
    expect(renderToStaticMarkup(<WaitLines uploading={[]} failed={[]} />)).toBe('');
  });

  it('item 8: after a save, the card\'s foot carries "Raise a finding about this question" to the same target, below the Save row', () => {
    const h = card({ current: V2, historyCount: 2 });
    const href = `/orgs/acme/projects/p1/findings?raise=1&amp;stage=pre-processing&amp;questionId=Q-PP-01&amp;versionId=dv2#raise`;
    expect(h).toContain(`href="${href}"`);
    expect(h.indexOf(href)).toBeGreaterThan(h.indexOf('decision-save-bar'));
    expect(words(h)).toContain(QUESTION_COPY.findingLink.raise);
  });
  it('spec 9.7 archived: no card at all (a person who may not record, the project archived); the page shows the reading view and its note', () => {
    expect(card({ canWrite: false, projectArchived: true, current: V2, historyCount: 2 })).toBe('');
  });
  it('item 8: no raise link with no version, after a withdrawal, or for a person who may not raise', () => {
    expect(card()).not.toContain(QUESTION_COPY.findingLink.raise);
    expect(card({ current: { ...V2, status: 'withdrawn', withdrawalCode: 'duplicate' }, historyCount: 2 })).not.toContain(QUESTION_COPY.findingLink.raise);
    expect(card({ current: V2, historyCount: 2, canRaiseFinding: false })).not.toContain(QUESTION_COPY.findingLink.raise);
  });
});

describe('T3c: the fix round on T3b, the owner\'s 14:30 rulings and the routed items', () => {
  it('review A I-1: on the stage\'s last question, All questions is text, not a link, while a Save waits or is out', () => {
    const held = renderToStaticMarkup(<NextWay next={null} stageHref={STAGE} held />);
    expect(held).not.toMatch(/<a[\s>]/);
    expect(held).not.toContain('href=');
    expect(words(held)).toBe(`${QUESTION_COPY.foot.last} ${QUESTION_COPY.nav.allQuestions} ${QUESTION_COPY.end.link}`);
    expect(held).toContain('data-next-held');
    const live = renderToStaticMarkup(<NextWay next={null} stageHref={STAGE} held={false} />);
    expect(live).toMatch(new RegExp(`<a [^>]*href="${esc(STAGE)}"[^>]*>${QUESTION_COPY.nav.allQuestions}</a>`));
    // a focused way off the page is marked, so the form can move focus to the save bar when it becomes text
    expect(live).toContain('data-held-on-save');
    expect(renderToStaticMarkup(<NextWay next={NEXT} stageHref={STAGE} held={false} />)).toContain('data-held-on-save');
  });

  it('reviews B M-r4-3 and A M-1: the foot\'s History and finding links are text while a Save waits or is out', async () => {
    const { HeldLink, HeldFindingLink, SaveHeldContext } = await import('@/components/decision/SaveHeld');
    const foot = (held: boolean) => renderToStaticMarkup(
      <SaveHeldContext.Provider value={held}>
        <HeldLink href={HISTORY}>{QUESTION_COPY.reading.history(2)}</HeldLink>
        <HeldFindingLink orgSlug="acme" projectId="p1" stage="pre-processing" questionId="Q-PP-01" currentVersionId="dv2" openFinding={{ findingId: 'f1' }} canRaise />
      </SaveHeldContext.Provider>);
    const live = foot(false);
    expect(live.match(/<a [^>]*href=/g)).toHaveLength(3);
    expect(live.match(/data-held-on-save/g)).toHaveLength(2);
    const held = foot(true);
    expect(held).not.toMatch(/<a[\s>]/);
    expect(words(held)).toBe(`${QUESTION_COPY.reading.history(2)}${QUESTION_COPY.findingLink.open} ${QUESTION_COPY.findingLink.view}${QUESTION_COPY.findingLink.raise}`);
    expect(held.match(/data-link-held/g)).toHaveLength(3);
    // the card's own foot is rendered by the form, inside its context: live links on first render
    const h = card({ current: V2, historyCount: 2 });
    expect(h.indexOf('</form>')).toBeLessThan(h.indexOf('class="decision-card__meta"'));
    expect(h).toMatch(new RegExp(`<a [^>]*href="${esc(HISTORY)}"[^>]*>${esc(QUESTION_COPY.reading.history(2))}</a>`));
  });

  it('item 9: "View the finding" whenever the question has an open finding; "Raise a finding" after a save, for a role that may raise', () => {
    const view = `href="/orgs/acme/projects/p1/findings/f1"`;
    const withOpen = card({ current: V2, historyCount: 2 }, { open: 1 });
    expect(withOpen).toContain(view);
    expect(words(withOpen)).toContain(`${QUESTION_COPY.findingLink.open} ${QUESTION_COPY.findingLink.view}`);
    expect(card({ current: V2, historyCount: 2 })).not.toContain(view);
    // after a withdrawal the open finding is still shown; raising needs a current decision
    const withdrawn = card({ current: { ...V2, status: 'withdrawn', withdrawalCode: 'duplicate', decidedBy: null, declaredDate: null }, historyCount: 2 }, { open: 1 });
    expect(withdrawn).toContain(view);
    expect(words(withdrawn)).not.toContain(QUESTION_COPY.findingLink.raise);
    expect(words(card({ current: V2, historyCount: 2 }))).toContain(QUESTION_COPY.findingLink.raise);
    expect(words(card({ current: V2, historyCount: 2, canRaiseFinding: false }))).not.toContain(QUESTION_COPY.findingLink.raise);
  });

  it('item 7: the version line only while the answer differs from the saved version; a first decision always has it', async () => {
    const { answerDiffers } = await import('@/components/decision/DecisionForm');
    const data = { ...PANEL, current: V2 };
    const same = draftFromCurrent(data);
    expect(answerDiffers(same, data)).toBe(false);
    expect(consequence(card({ current: V2 }))).not.toContain(C.version(3));
    expect(answerDiffers({ ...same, status: 'done' }, data)).toBe(true);
    expect(answerDiffers({ ...same, reason: `${same.reason}.` }, data)).toBe(true);
    expect(answerDiffers({ ...same, evidenceIds: ['e9'] }, data)).toBe(true);
    expect(answerDiffers({ ...same, decidedBy: { kind: 'member', userId: 'u-j' } }, data)).toBe(true);
    // the date opens empty: the saved date typed again is no change; another date is
    expect(answerDiffers({ ...same, date: { day: '12', month: '10', year: '2026' } }, data)).toBe(false);
    expect(answerDiffers({ ...same, date: { day: '13', month: '10', year: '2026' } }, data)).toBe(true);
    expect(answerDiffers(draftFromCurrent(PANEL), PANEL)).toBe(true);
    expect(consequence(card({}))).toContain(C.version(1));
    // a withdrawal is not a saved answer: any answer makes the next version
    const withdrawn = { ...PANEL, current: { ...V2, status: 'withdrawn' as const, withdrawalCode: 'duplicate' as const, decidedBy: null, declaredDate: null } };
    expect(answerDiffers(draftFromCurrent(withdrawn), withdrawn)).toBe(true);
  });

  it('item 8: a link to the platform\'s own host reads "<name> (<host>)"; any other host, or no origin configured, keeps "opens another site"', async () => {
    const { EvidenceItemText, VersionEvidenceList, platformOrigin } = await import('@/components/evidence/VersionEvidenceList');
    const item = { id: 'e1', kind: 'link', url: 'https://rai.example.org/orgs/acme/findings/f1', label: 'Our finding', fileName: null, mimeType: null, byteSize: null, erased: null } as unknown as Parameters<typeof EvidenceItemText>[0]['item'];
    const text = (ownOrigin: string | null) => words(renderToStaticMarkup(<EvidenceItemText orgSlug="acme" item={item} ownOrigin={ownOrigin} />));
    expect(text('https://rai.example.org')).toBe(`Our finding ${EVIDENCE_COPY.list.linkToOwn('rai.example.org')}`);
    expect(text('https://rai.example.org')).not.toContain('opens another site');
    expect(text('https://other.example')).toBe(`Our finding ${EVIDENCE_COPY.list.linkTo('rai.example.org')}`);
    expect(text(null)).toBe(`Our finding ${EVIDENCE_COPY.list.linkTo('rai.example.org')}`);
    // the server reads the configured origin; with none configured nothing is own
    const env = { auth: process.env.AUTH_URL, next: process.env.NEXTAUTH_URL };
    try {
      delete process.env.AUTH_URL; delete process.env.NEXTAUTH_URL;
      expect(platformOrigin()).toBeNull();
      expect(words(renderToStaticMarkup(<VersionEvidenceList orgSlug="acme" items={[item]} />))).toContain('opens another site');
      process.env.AUTH_URL = 'https://rai.example.org/app';
      expect(platformOrigin()).toBe('https://rai.example.org');
      expect(words(renderToStaticMarkup(<VersionEvidenceList orgSlug="acme" items={[item]} />))).toBe(`Our finding ${EVIDENCE_COPY.list.linkToOwn('rai.example.org')}`);
    } finally {
      if (env.auth === undefined) delete process.env.AUTH_URL; else process.env.AUTH_URL = env.auth;
      if (env.next === undefined) delete process.env.NEXTAUTH_URL; else process.env.NEXTAUTH_URL = env.next;
    }
  });

  it('review A A3-1: the host\'s style lives with its renderer, so every page that lists evidence draws it', () => {
    expect(readFileSync('components/evidence/VersionEvidenceList.tsx', 'utf8')).toContain("import './VersionEvidenceList.css';");
    expect(readFileSync('components/evidence/VersionEvidenceList.css', 'utf8')).toMatch(/\.evidence-item__host\s*\{[^}]*color:\s*var\(--color-ink-muted\)/);
    expect(readFileSync('components/evidence/EvidenceBlock.css', 'utf8')).not.toContain('.evidence-item__host');
  });

  it('review A A3-3: the corner\'s date names its zone; one zone constant for the card and the history', () => {
    const h = card({ current: V2, historyCount: 2 });
    const corner = h.match(/<div class="decision-card__corner">[\s\S]*?<\/div>/)![0];
    expect(words(corner)).toBe(`${F.card.savedAs(2)}12 Oct 2026 UTC`);
    for (const f of ['components/decision/DecisionCard.tsx', 'components/decision/DecisionHistoryList.tsx']) {
      expect(readFileSync(f, 'utf8')).not.toContain("'Africa/Kampala'");
      expect(readFileSync(f, 'utf8')).toContain('PLATFORM_ZONE');
    }
    expect(readFileSync('components/decision/DecisionCard.tsx', 'utf8')).not.toContain('decision!');
  });

  it('item 10 (lane 6\'s first-use rule): the status cards, the line with no status, the owner\'s sentence and the seal marker define their terms', async () => {
    const { firstUseProblems } = await import('../helpers/firstUseHtml');
    // Left, and reported: the evidence block's stored-file sentence ("fingerprint", T1's verbatim words) and the kit
    // SavedMark's "Saved as version N" (components/ui), neither in this task's items.
    const left = new Set(['fingerprint', 'version-of-a-decision']);
    const seals = [{ sealId: 's1', sealNumber: 1, reviewName: 'Pre-processing review 1' }] as never;
    for (const h of [card({}), card({ current: V2, historyCount: 2, seals }), card({ current: { ...V2, status: 'done' }, historyCount: 2 }, { open: 1 })]) {
      expect(firstUseProblems(h).filter((x) => !left.has(x.id))).toEqual([]);
    }
    // the no-status line: Partly, Not yet and "version" each with its (i), named for the term; "finding" with its definition
    const none = card({});
    for (const [id, word, after] of [['partly', 'Partly', ''], ['not-yet', 'Not yet', ''], ['version-of-a-decision', 'version', ' 1']]) {
      // "version 1" reads as one: its (i) follows the number
      expect(decode(none)).toContain(`<span data-term="${id}">${word}</span>${after}<span class="ui-term-tip"><button type="button" class="ui-term-tip__button" popoverTarget="decision-consequence-tip-${id}"`);
      expect(decode(none)).toContain(`aria-label="${F.whatMeans(word)}"`);
    }
    expect(none).toContain('<span data-term="finding">finding</span>');
    // the card's first seal marker defines its terms (lane 6's defineTerms)
    expect(card({ current: V2, historyCount: 2, seals })).toMatch(/class="seal-markers"[\s\S]*data-definition="seal"/);
  });
});

describe('T5: the last fix round before the hand-in', () => {
  it('N1: the unsaved line\'s live span still holds the whole sentence; beside it, hidden from assistive technology, its first sentence alone', async () => {
    const { SaveStatus } = await import('@/components/decision/SaveStatus');
    const shown = renderToStaticMarkup(<SaveStatus status={null} draftSavedAt="2026-10-12T07:43:00.000Z" storageUnavailable={false} />);
    expect(shown).toMatch(new RegExp(`<span aria-live="polite" aria-atomic="true"[^>]*>${esc(F.unsaved)}</span>`));
    expect(shown).toMatch(new RegExp(`<span class="save-status__unsaved-short" aria-hidden="true">${esc(F.unsavedShort)}</span>`));
    expect(`${F.unsavedShort} ${F.unsavedMore}`).toBe(F.unsaved);
    const none = renderToStaticMarkup(<SaveStatus status={null} draftSavedAt={null} storageUnavailable={false} />);
    expect(none).not.toContain(F.unsavedShort);
    // the words after the first sentence follow the bar's place in the card, out of the bar (DecisionForm.css hides them on a phone)
    const css = readFileSync('components/decision/DecisionForm.css', 'utf8');
    expect(css).toMatch(/\.save-status__unsaved-short,\s*\.decision-unsaved-more\s*\{\s*display: none;/);
  });

  it('A3c-2: the phone\'s saved block\'s history link is one a held Save turns into text, like the card\'s other ways', () => {
    const h = card({ current: V2, historyCount: 2 });
    const block = /<div class="decision-card__saved-block">([\s\S]*?)<form/.exec(h);
    expect(block, 'the saved block, then the form').not.toBeNull();
    const link = /<a [^>]*>the history<\/a>/.exec(block![1]);
    expect(link, 'the saved block\'s history link').not.toBeNull();
    expect(link![0]).toContain(`href="${HISTORY}"`);
    expect(link![0]).toContain('data-held-on-save=""');
  });

  it('design N4: the phone\'s saved block draws the filled Done mark, as the wide corner does', () => {
    const h = card({ current: V2, historyCount: 2 });
    const block = /<div class="decision-card__saved-block">([\s\S]*?)<form/.exec(h)![1];
    expect(block).toContain('class="decision-card__saved-disc"');
    expect(block).not.toContain('class="ui-icon"');
  });

  it('A3c-2: the kit\'s SavedMark takes the caller\'s history link (additive); without it the mark is as before', async () => {
    const { SavedMark } = await import('@/components/ui/SavedMark');
    const saved = { version: 2, savedAt: '2026-10-12T07:42:00.000Z' as const, decidedOn: null };
    const before = renderToStaticMarkup(<SavedMark saved={saved} historyHref="/h" live={false} savedTime="10:42 EAT" />);
    expect(before).toContain('<a href="/h">');
    expect(renderToStaticMarkup(<SavedMark saved={saved} historyHref="/h" live={false} savedTime="10:42 EAT" historyLink={<b>held</b>} />))
      .toBe(before.replace(/<a href="\/h">([^<]*)<\/a>/, '<b>held</b>'));
  });

  it('A3c-3: re-saving the same answer against newer wording makes a new version (the server\'s rule), so the line says so', async () => {
    const { answerDiffers } = await import('@/components/decision/DecisionForm');
    const older = { ...V2, content: { ...V2.content, semver: '0.0.0-older' } };
    const data = { ...PANEL, current: older };
    expect(answerDiffers(draftFromCurrent(data), data)).toBe(true);
    expect(consequence(card({ current: older, historyCount: 2 }))).toContain(C.version(3));
    // the same wording and the same answer: no new version, no line
    const same = { ...PANEL, current: V2 };
    expect(answerDiffers(draftFromCurrent(same), same)).toBe(false);
  });

  it('design N2: every line of the card that gives a time names one zone, never two side by side', () => {
    const h = card({ current: V2, historyCount: 2 });
    const lines = [...h.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map((m) => words(m[1]));
    const timed = lines.filter((l) => /\b(UTC|EAT)\b/.test(l));
    expect(timed.length).toBeGreaterThanOrEqual(3);
    for (const l of timed) expect(new Set(l.match(/\b(UTC|EAT)\b/g)).size, l).toBe(1);
  });

  it('design "to confirm": on the open-finding branch (Partly or Not yet) a changed answer\'s line ends with its version', async () => {
    expect(await changed({ current: V2, historyCount: 2 }, 1)).toMatch(/until your team closes it\. This save becomes version 3\.$/);
    expect(await changed({ current: { ...V2, status: 'not_yet', reasonCode: 'ny_planned_later' }, historyCount: 2 }, 1)).toMatch(/This save becomes version 3\.$/);
  });
});

describe('T10 I5 (owner 19:30, "Empty, show last date"): a re-decision names the last declared date beside empty boxes', () => {
  const boxes = (h: string) => [...h.matchAll(/<input[^>]*inputmode="numeric"[^>]*>/gi)].map((m) => m[0]);
  const draft = (current: DecisionVersionView | null) => draftFromCurrent({ ...PANEL, current });

  it('a current version shows "Last decided on <date>" at its precision, the boxes stay empty, every box names the line, and Today stays', () => {
    for (const [declaredDate, declaredPrecision, shown] of [['2026-11-15', 'day', '15 Nov 2026'], ['2026-11', 'month', 'Nov 2026'], ['2026', 'year', '2026']] as const) {
      const current = { ...V1, declaredDate, declaredPrecision };
      expect(draft(current).date).toEqual({ day: '', month: '', year: '' });
      const h = card({ current, historyCount: 1 });
      expect(words(h)).toContain(F.lastDecidedOn(shown));
      expect(F.lastDecidedOn(shown)).toBe(`Last decided on ${shown}`);
      // Inside the date's group, under its legend and before the boxes.
      const group = /<fieldset class="ui-date"[\s\S]*?<\/fieldset>/.exec(h)?.[0] ?? '';
      expect(group).toMatch(new RegExp(`<legend[\\s\\S]*?</legend><div class="ui-field__hint" id="decision-hint">${F.lastDecidedOn(shown)}</div>`));
      const ins = boxes(h);
      expect(ins).toHaveLength(3);
      for (const i of ins) {
        expect(i).not.toMatch(/value="[^"]+"/);
        expect(i).toContain('aria-describedby="decision-hint decision-date-hint"');
      }
      expect(h).toMatch(/<button[^>]*>Today<\/button>/);
    }
  });

  it('a first decision and a withdrawal as the current version show no such line', () => {
    expect(words(card())).not.toContain('Last decided on');
    const withdrawn = { ...V2, status: 'withdrawn' as const, reason: 'x', withdrawalCode: 'duplicate' as const, decidedBy: null };
    const h = card({ current: withdrawn, historyCount: 2 });
    expect(words(h)).not.toContain('Last decided on');
    expect(h).not.toContain('id="decision-hint"');
  });
});
