import { textErasedLine } from '@/lib/documents/copy';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionDraft } from '@/lib/question/draft';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { gateStatus } from '@/lib/question/saveOutcome';
import { DECISION_FORM_COPY } from '@/lib/decision/form/copy';
import { DECISION_OUTCOME_COPY } from '@/lib/decision/outcome/copy';
import { deciderLabel, FINDING_NOTE } from '@/lib/decision/copy';
import { QUESTION_COPY } from '@/lib/question/copy';
import { AUTHZ_COPY } from '@/lib/authz/copy';
import { STATUS_MARK_COPY } from '@/lib/ui/copy';

/**
 * The S-12 regions DEC-b fills (W-3, W-4; UX-09 to UX-12, UX-25, UX-28; NFR-A11Y-03, NFR-A11Y-04), rendered as
 * static markup: hooks run, effects do not, so this is the first markup a browser receives.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/x', useParams: () => ({ slug: 'acme' }) }));

const { DecisionFields, FIELD_TARGET } = await import('@/components/decision/DecisionFields');
const { SaveStatus } = await import('@/components/decision/SaveStatus');
const { ConflictView } = await import('@/components/decision/ConflictView');
const { CurrentDecision } = await import('@/components/decision/CurrentDecision');
const { draftFromCurrent, draftErrors, toSaveBody } = await import('@/lib/question/draft');
const { todayParts } = await import('@/lib/ui/dateParts');
const { Button } = await import('@/components/ui/Button');
const { Select } = await import('@/components/ui/Select');
const { DateField } = await import('@/components/ui/DateField');
const { safeDraftHref } = await import('@/components/decision/DraftsOnThisDevice');
const { DecisionForm } = await import('@/components/decision/DecisionForm');
const { QuestionPanelRegions } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page');

const QUESTION = {
  id: 'Q-PP-01', type: 'likert-5', text: 'Have you evaluated whether AI is the right approach?', principle: 'Proportionality',
  gaps: [], expectedPractice: 'Old wording.', whyAsked: 'y', reasonPrompt: 'z', evidenceExamples: [],
  stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0,
} as LoadedQuestion;
const V2: DecisionVersionView = {
  id: 'dv2', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 2, baseVersionNumber: 1,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'partly', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Theirs', reasonErased: null,
  decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, declaredDate: '2026-10-12', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-10-12T07:42:00.000Z', evidence: [],
};
const PANEL: QuestionPanelData = {
  orgSlug: 'acme', projectId: 'p1', projectArchived: false, stage: 'pre-processing', question: QUESTION, runningQuestion: QUESTION,
  position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' }, current: null, historyCount: 0, seals: [],
  reasonCodes: [
    { code: 'ny_planned_later', status: 'not_yet', label: 'Planned for later', useWhen: '', reasonMustSay: '' },
    { code: 'na_other', status: 'not_applicable', label: 'Other reason', useWhen: '', reasonMustSay: '' },
  ],
  members: [{ userId: 'u-j', name: 'Joseph K.' }], viewer: { userId: 'u-me', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: null, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const EMPTY: DecisionDraft = draftFromCurrent(PANEL, null);

/** `whoWhenOpen` is true by default: the cases that look into Decided by and Decided on read the opened fields (answer cost 4). */
const html = (p: Partial<QuestionPanelData> = {}, v: Partial<DecisionDraft> = {}, whoWhenOpen = true) =>
  renderToStaticMarkup(<DecisionFields data={{ ...PANEL, ...p }} value={{ ...EMPTY, ...v }} errors={[]} disabled={false} onChange={() => {}} whoWhenOpen={whoWhenOpen} onOpenWhoWhen={() => {}} />);

describe('S-12 decision fields', () => {
  it('UX-09 R2: a native radio group named Status, four options in order, and the reason code only with Not applicable or Not yet; the finding note is no longer under the legend', () => {
    const h = html();
    expect(h).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Status<\/legend>/);
    expect([...h.matchAll(/<input[^>]*type="radio"[^>]*value="([a-z_]+)"/g)].map((m) => m[1])).toEqual(['done', 'partly', 'not_yet', 'not_applicable']);
    expect(h).not.toContain(FINDING_NOTE);
    expect(h).not.toContain(DECISION_FORM_COPY.fields.reasonCode);
    const ny = html({}, { status: 'not_yet' });
    expect(ny).toContain(DECISION_FORM_COPY.fields.reasonCode);
    expect(ny).toContain('Planned for later');
    expect(ny).not.toContain('Other reason');   // the codes of the chosen status only
  });

  it('UX-10 FR-DEC-10 NFR-A11Y-04: the date fields are empty on open; Same as version N is offered beside Today, not filled in', () => {
    const data = { ...PANEL, current: V2, lastOwnSaveDate: '2026-10' };
    const h = html({ current: V2, lastOwnSaveDate: '2026-10' }, draftFromCurrent(data, null));
    const dateInputs = [...h.matchAll(/<input[^>]*inputmode="numeric"[^>]*>/gi)];
    expect(dateInputs).toHaveLength(3);
    expect(dateInputs.every((m) => !/value="[^"]+"/.test(m[0]))).toBe(true);
    expect(h).toContain(DECISION_FORM_COPY.startingNote);
    expect(h).toMatch(/<button[^>]*>Today<\/button>/);
    expect(h).toContain(`>${DECISION_FORM_COPY.sameAsCurrent('12 Oct 2026')}</button>`);
    expect(h).toContain(`>${DECISION_FORM_COPY.sameAsMyLast('Oct 2026')}</button>`);
    expect(html({ current: null, lastOwnSaveDate: null })).not.toMatch(/Same date as/);
  });

  it('FR-DEC-01: a new version opens from the current version\'s fields, and a withdrawal opens an empty form', () => {
    const d = draftFromCurrent({ ...PANEL, current: V2 }, null);
    expect(d).toMatchObject({ status: 'partly', reason: 'Theirs', decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, date: { day: '', month: '', year: '' } });
    expect(draftFromCurrent({ ...PANEL, current: { ...V2, status: 'withdrawn', reason: 'x', withdrawalCode: 'duplicate', decidedBy: null } }, null))
      .toMatchObject({ status: null, reason: '', decidedBy: { kind: 'member', userId: 'u-me' } });
  });

  it('UX-11: Decided by lists You first, then members, then the Outside roles group', () => {
    const h = html({ viewer: { userId: 'u-me', name: 'Amina N.', role: 'assessor' }, members: [{ userId: 'u-j', name: 'Joseph K.' }] });
    expect(h).toMatch(/<option[^>]*>You \(Amina N\.\)<\/option>\s*<option[^>]*>Joseph K\.<\/option>\s*<optgroup label="Someone without a platform account">\s*<option[^>]*>Principal investigator<\/option>/);
  });

  it('UX-12 ruling (a): the reason hint is the own prompt of the question, and the count in text, linked to the field', () => {
    const h = html({}, { reason: 'x'.repeat(212) });
    expect(h).toContain('212 / 4,000 characters');
    expect(h).toMatch(/<textarea[^>]*aria-describedby="[^"]*reason-help[^"]*"/);
    expect(h).toContain(`<p id="decision-reason-help" class="decision-fields__help">${PANEL.runningQuestion.reasonPrompt}</p>`);
  });

  it('FR-CNT-04 FR-CNT-03 (screen): the gate takes a scope answer, a checklist its options with the count in text', () => {
    const gate = html({ question: { ...QUESTION, id: 'Q-PP-GATE-SENSITIVE', type: 'gate' } });
    expect(gate).toMatch(/<legend[^>]*>Answer \(required\)<\/legend>/);
    expect(gate).not.toMatch(/<legend[^>]*>Status<\/legend>/);
    expect(gate).toContain(DECISION_FORM_COPY.scopeNote);
    const list = html({ question: { ...QUESTION, id: 'Q-PP-16', type: 'checklist', options: ['A', 'B', 'C'] } }, { optionsInPlace: ['B'] });
    expect(list).toMatch(/<legend[^>]*>Which of these are in place\?<\/legend>/);
    expect([...list.matchAll(/type="checkbox"/g)]).toHaveLength(3);
    expect(list).toContain('1 of 3 in place');
    expect(list).toMatch(/<legend[^>]*>Status<\/legend>/);
  });

  it('M-11 NFR-A11Y-03: a field error is next to its field and linked to it', () => {
    const h = renderToStaticMarkup(<DecisionFields data={PANEL} value={EMPTY} errors={[{ field: 'reason', message: 'Write a reason.' }]} disabled={false} onChange={() => {}} whoWhenOpen onOpenWhoWhen={() => {}} />);
    expect(h).toMatch(/<textarea[^>]*aria-invalid="true"/);
    expect(h).toMatch(/<textarea[^>]*aria-describedby="[^"]*decision-reason-error/);
    expect(h).toMatch(/id="decision-reason-error"[^>]*>Write a reason\.</);
  });

  it('plan 1A Task 17 R3: every control keeps its id and name, and each status card shows its radio button and its status mark', () => {
    const h = html({ question: { ...QUESTION, type: 'checklist', options: ['A', 'B'] } }, { status: 'not_yet' });
    for (const v of ['done', 'partly', 'not_yet', 'not_applicable']) {
      const radio = h.match(new RegExp(`<input[^>]*id="decision-status-${v}"[^>]*>`))?.[0] ?? '';
      for (const attr of ['type="radio"', 'name="status"', `value="${v}"`, `aria-describedby="decision-status-${v}-help"`]) expect(radio).toContain(attr);
    }
    expect(h.match(/class="ui-mark__shape"/g)).toHaveLength(4);
    expect(h).toMatch(/<input[^>]*id="decision-option-0"[^>]*name="optionsInPlace"/);
    expect(h).toMatch(/<select[^>]*id="decision-reason-code"[^>]*name="reasonCode"/);
    expect(h).toMatch(/<option value=""[^>]*>Choose one<\/option>/);
    expect(h).toMatch(/<textarea[^>]*id="decision-reason"[^>]*name="reason"[^>]*aria-describedby="decision-reason-count decision-reason-help"/);
    expect(h).toMatch(/<select[^>]*id="decision-decided-by"[^>]*name="decidedBy"/);
    for (const part of ['day', 'month', 'year']) expect(h).toMatch(new RegExp(`<input[^>]*id="decision-${part}"[^>]*inputmode="numeric"`, 'i'));
    expect(h).toMatch(/<fieldset[^>]*aria-describedby="decision-options-count"/);
    expect(h).toContain(`<p id="decision-options-count" class="decision-fields__count">${DECISION_FORM_COPY.optionsCount(0, 2)}</p>`);
  });

  it('plan 1A Task 17: a date error keeps its id, and the reason count is not a limit on typing', () => {
    const h = renderToStaticMarkup(<DecisionFields data={PANEL} value={{ ...EMPTY, reason: 'x'.repeat(4001) }} errors={[{ field: 'declaredDate', message: 'February has 28 days.' }]} disabled={false} onChange={() => {}} whoWhenOpen onOpenWhoWhen={() => {}} />);
    expect(h).toMatch(/id="decision-declaredDate-error"[^>]*>February has 28 days\.</);
    expect(h).toMatch(/<input[^>]*id="decision-day"[^>]*aria-describedby="[^"]*decision-declaredDate-error/);
    expect(h).not.toMatch(/<textarea[^>]*maxlength/i);
    expect(h).toContain('4,001 / 4,000 characters');
  });

  /** Every element of a rendered tree that `pred` accepts; a function component's own output, its children not expanded. */
  function findAll(node: ReactNode, pred: (e: ReactElement<Record<string, unknown>>) => boolean, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
    if (Array.isArray(node)) { node.forEach((n) => findAll(n, pred, out)); return out; }
    if (isValidElement<Record<string, unknown>>(node)) { if (pred(node)) out.push(node); findAll(node.props.children as ReactNode, pred, out); }
    return out;
  }
  const noop = () => {};
  const fieldsFor = (over: Partial<Parameters<typeof DecisionFields>[0]> = {}) =>
    ({ data: PANEL, value: EMPTY, errors: [], disabled: false, onChange: noop, whoWhenOpen: false, onOpenWhoWhen: noop, ...over });

  describe('answer cost 4: who and when as one line', () => {
    afterEach(() => { vi.useRealTimers(); });

    it('a first answer shows "Decided by you, 22 Nov 2026" and a Change button, and no Decided by select', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-11-22T12:00:00Z'));   // midday UTC: the 22nd on any device from UTC-12 to UTC+11
      const h = renderToStaticMarkup(<DecisionFields {...fieldsFor({ value: draftFromCurrent(PANEL, todayParts(new Date())) })} />);
      expect(h).toContain('Decided by you, 22 Nov 2026');
      const button = h.match(/<button[^>]*>Change<\/button>/)?.[0] ?? '';
      expect(button).toContain('aria-expanded="false"');
      expect(button).toContain('type="button"');
      expect(h).not.toContain('id="decision-decided-by"');
      expect(h).not.toContain('id="decision-day"');
      // before the device's date is known the line says "today", and a change keeps the earlier decider
      expect(renderToStaticMarkup(<DecisionFields {...fieldsFor()} />)).toContain('Decided by you, today');
      const change = draftFromCurrent({ ...PANEL, current: V2 }, todayParts(new Date()));
      expect(renderToStaticMarkup(<DecisionFields {...fieldsFor({ data: { ...PANEL, current: V2 }, value: change })} />))
        .toContain('Decided by Principal investigator, 22 Nov 2026');
      // a restored draft's own who and when are what the line shows, not the defaults
      const own = { ...EMPTY, decidedBy: { kind: 'member' as const, userId: 'u-j' }, date: { day: '12', month: '10', year: '2026' }, whoWhenChanged: true };
      expect(renderToStaticMarkup(<DecisionFields {...fieldsFor({ value: own })} />)).toContain('Decided by Joseph K., 12 Oct 2026');
    });

    it('the Change button is named with the line it changes, and Change alone does not edit the answer', () => {
      const tree = DecisionFields(fieldsFor({ onOpenWhoWhen: noop }));
      const button = findAll(tree, (e) => e.type === Button)[0];
      expect(button.props['aria-expanded']).toBe(false);
      expect(button.props['aria-describedby']).toBe('decision-who-when-summary');
      expect(renderToStaticMarkup(<DecisionFields {...fieldsFor()} />)).toMatch(/id="decision-who-when-summary"[^>]*>Decided by you, today</);
    });

    it('Change shows the select and the date fields; opening alone leaves whoWhenChanged, and the next edit to who or when sets it', () => {
      const closed = html({}, {}, false);
      expect(closed).not.toContain('id="decision-decided-by"');
      const open = html({}, {}, true);
      expect(open).toMatch(/<select[^>]*id="decision-decided-by"/);
      for (const part of ['day', 'month', 'year']) expect(open).toMatch(new RegExp(`<input[^>]*id="decision-${part}"`));
      expect(open).toMatch(/<button[^>]*>Today<\/button>/);
      expect(open).not.toMatch(/<button[^>]*>Change<\/button>/);
      // the press only asks the form to open the fields: no edit reaches onChange
      const opened = vi.fn(); const changed = vi.fn();
      const closedTree = DecisionFields(fieldsFor({ onOpenWhoWhen: opened, onChange: changed }));
      (findAll(closedTree, (e) => e.type === Button)[0].props.onClick as () => void)();
      expect(opened).toHaveBeenCalledTimes(1);
      expect(changed).not.toHaveBeenCalled();
      // an edit to Decided by, or to the date, records the change in the draft
      const edits = vi.fn();
      const openTree = DecisionFields(fieldsFor({ whoWhenOpen: true, onChange: edits }));
      const select = findAll(openTree, (e) => e.type === Select && e.props.id === 'decision-decided-by')[0];
      (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'member:u-j' } });
      expect(edits).toHaveBeenLastCalledWith(expect.objectContaining({ decidedBy: { kind: 'member', userId: 'u-j' }, whoWhenChanged: true }));
      const date = findAll(openTree, (e) => e.type === DateField)[0];
      (date.props.onChange as (d: { day: string; month: string; year: string }) => void)({ day: '3', month: '11', year: '2026' });
      expect(edits).toHaveBeenLastCalledWith(expect.objectContaining({ date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: true }));
      // any other edit leaves the record as it was
      const reasonField = findAll(openTree, (e) => e.type !== Select && e.type !== DateField && typeof e.props.onChange === 'function' && e.props.name === 'reason')[0];
      (reasonField.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: 'Because' } });
      expect(edits).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'Because', whoWhenChanged: false }));
    });

    it('a changed who or when the line cannot state opens the fields instead of saying "today"; a readable one shows its own date', () => {
      const half = { ...EMPTY, whoWhenChanged: true, date: { day: '5', month: '', year: '' } };
      const h = renderToStaticMarkup(<DecisionFields {...fieldsFor({ value: half })} />);
      expect(h).toMatch(/<input[^>]*id="decision-day"[^>]*value="5"/);
      expect(h).not.toContain('Decided by you, today');
      expect(renderToStaticMarkup(<DecisionFields {...fieldsFor({ value: { ...EMPTY, whoWhenChanged: true, date: { day: '', month: '', year: '' } } })} />)).toContain('id="decision-decided-by"');
      expect(renderToStaticMarkup(<DecisionFields {...fieldsFor({ value: { ...EMPTY, whoWhenChanged: true, decidedBy: null, date: { day: '3', month: '11', year: '2026' } } })} />)).toContain('id="decision-decided-by"');
      const fine = renderToStaticMarkup(<DecisionFields {...fieldsFor({ value: { ...EMPTY, whoWhenChanged: true, date: { day: '3', month: '11', year: '2026' } } })} />);
      expect(fine).toContain('Decided by you, 3 Nov 2026');
      expect(fine).not.toContain('id="decision-decided-by"');
    });

    it('a server field error on decidedBy or declaredDate opens the fields, and the error link\'s target exists', () => {
      for (const field of ['decidedBy', 'declaredDate'] as const) {
        const h = renderToStaticMarkup(<DecisionFields {...fieldsFor({ errors: [{ field, message: 'Fix this.' }] })} />);
        expect(FIELD_TARGET[field]).toBe(field === 'decidedBy' ? 'decision-decided-by' : 'decision-day');
        expect(h, field).toContain(`id="${FIELD_TARGET[field]}"`);
        expect(h, field).toContain('Fix this.');
      }
      // an error on another field leaves them closed
      const other = renderToStaticMarkup(<DecisionFields {...fieldsFor({ errors: [{ field: 'reason', message: 'Fix this.' }] })} />);
      expect(other).not.toContain('id="decision-decided-by"');
    });

    it('the reason box is labelled optional, has no required attribute, and Save with Done and no reason sends reason \'\'', () => {
      const h = html();
      const label = h.match(/<label[^>]*for="decision-reason"[^>]*>([\s\S]*?)<\/label>/)?.[1] ?? '';
      expect(label.replace(/<[^>]+>/g, '')).toBe('Reason (optional)');
      expect(h.match(/<textarea[^>]*id="decision-reason"[^>]*>/)?.[0]).not.toMatch(/\brequired\b/);
      const done = { ...draftFromCurrent(PANEL, { day: '22', month: '11', year: '2026' }), status: 'done' as const, reason: '' };
      expect(draftErrors(done, PANEL, new Date('2026-11-22T12:00:00Z'))).toEqual([]);
      expect(toSaveBody(done, PANEL, null).reason).toBe('');
    });
  });
});

describe('S-12 status line and conflict view', () => {
  it('NFR-A11Y-03 UX-25: the status line has an empty polite and an empty assertive region from the first render', () => {
    const h = renderToStaticMarkup(<SaveStatus status={null} draftSavedAt={null} storageUnavailable={false} />);
    expect(h).toMatch(/role="status"[^>]*><\/[a-z]+>/);
    expect(h).toMatch(/role="alert"[^>]*><\/[a-z]+>/);
    expect(renderToStaticMarkup(<SaveStatus status={null} draftSavedAt={null} storageUnavailable />)).toContain(DECISION_FORM_COPY.noStorage);
    const failed = renderToStaticMarkup(<SaveStatus status={{ id: 'M-05', text: 'Not saved: connection lost. Your answer is kept on this device. Retry.', live: 'assertive', next: 'retry' }} draftSavedAt={null} storageUnavailable={false} />);
    expect(failed).toMatch(/role="status"[^>]*><\/[a-z]+>/);
    expect(failed).toMatch(/role="alert"[^>]*>Not saved: connection lost\./);
  });

  it('F4 UX-26: when the browser cannot keep drafts, the failure the screen reader hears says so too', () => {
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const h = renderToStaticMarkup(<SaveStatus status={{ id: 'M-05', text: 'Not saved: connection lost. Your answer is kept on this device. Retry.', live: 'assertive', next: 'retry' }} draftSavedAt={null} storageUnavailable />);
    expect(h).toMatch(new RegExp(`role="alert"[^>]*>Not saved: connection lost\\. Your answer is kept on this device\\. Retry\\. ${esc(DECISION_FORM_COPY.noStorage)}<`));
    expect(h.match(new RegExp(esc(DECISION_FORM_COPY.noStorage), 'g'))).toHaveLength(1);
  });

  it('CR-2 UX-26: a gate alert with no storage is the gate line alone, without "Save before leaving this page"', () => {
    for (const nav of [{ kind: 'go' as const, href: '/acceptances?callbackUrl=%2Fq' }, { kind: 'go' as const, href: '/change-password?callbackUrl=%2Fq' }]) {
      const gate = gateStatus(nav);
      const h = renderToStaticMarkup(<SaveStatus status={gate} draftSavedAt={null} storageUnavailable />);
      expect(h).toMatch(new RegExp(`role="alert"[^>]*>${gate.text.replace(/[.]/g, '\\.')}</`));
      expect(h).not.toContain(DECISION_FORM_COPY.noStorage);
    }
  });

  it('CR-1 ruling 5 UX-25: after a save that the person typed past, the line says Saved and also that a newer draft is on the device', () => {
    const h = renderToStaticMarkup(<SaveStatus status={{ id: 'M-03', text: 'Saved as version 1 at 10:42 EAT. Decided by: you. Entered by: you.', live: 'polite', next: 'none' }} draftSavedAt="2026-10-12T07:43:00.000Z" storageUnavailable={false} />);
    expect(h).toMatch(/role="status"[^>]*>Saved as version 1 at 10:42 EAT\./);
    expect(h).toMatch(new RegExp(DECISION_FORM_COPY.unsaved));
    // with no newer draft, "Saved" stands alone
    expect(renderToStaticMarkup(<SaveStatus status={{ id: 'M-03', text: 'Saved as version 1 at 10:42 EAT.', live: 'polite', next: 'none' }} draftSavedAt={null} storageUnavailable={false} />)).not.toContain(DECISION_FORM_COPY.unsaved);
  });

  it('C4 (Q18 (a)): when this browser can keep nothing, the signed-out line says to copy the text and never that it is kept', () => {
    const S = DECISION_OUTCOME_COPY.save;
    const h = renderToStaticMarkup(<SaveStatus status={{ id: 'M-08', text: S.signedOut, live: 'assertive', next: 'sign_in' }} draftSavedAt={null} storageUnavailable />);
    const alert = /role="alert"[^>]*>([^<]*)</.exec(h)?.[1];
    expect(alert).toBe('Not saved. You have been signed out. Copy your text before you sign in again: this browser cannot keep it.');
    expect(h).not.toContain('kept');
  });

  it('C4 (Q18 (a)): when this browser can keep nothing, the slow line drops "A copy of your text is kept in this browser."', () => {
    const S = DECISION_OUTCOME_COPY.save;
    const h = renderToStaticMarkup(<SaveStatus status={{ id: 'M-02', text: S.slow, live: 'polite', next: 'none' }} draftSavedAt={null} storageUnavailable />);
    expect(/role="status"[^>]*>([^<]*)</.exec(h)?.[1]).toBe('Still saving. The connection is slow.');
    expect(h).not.toContain('kept');
    expect(h).toContain(DECISION_FORM_COPY.noStorage);   // the no-storage line beside it, as before
  });

  it('C4 (Q18 (a)): with storage working, the signed-out and slow lines are as built', () => {
    const S = DECISION_OUTCOME_COPY.save;
    const out = renderToStaticMarkup(<SaveStatus status={{ id: 'M-08', text: S.signedOut, live: 'assertive', next: 'sign_in' }} draftSavedAt={null} storageUnavailable={false} />);
    expect(/role="alert"[^>]*>([^<]*)</.exec(out)?.[1]).toBe('Not saved. You have been signed out. Your text is kept in this browser. Sign in again to save it.');
    const slow = renderToStaticMarkup(<SaveStatus status={{ id: 'M-02', text: S.slow, live: 'polite', next: 'none' }} draftSavedAt={null} storageUnavailable={false} />);
    expect(/role="status"[^>]*>([^<]*)</.exec(slow)?.[1]).toBe('Still saving. The connection is slow. A copy of your text is kept in this browser.');
  });

  it('UX-28 M-10: the conflict view shows both reasons, who saved, and the three actions', () => {
    const h = renderToStaticMarkup(<ConflictView current={{ ...V2, reason: 'Theirs' }} mine={{ ...EMPTY, reason: 'Mine' }} viewerId="u-me" onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(h).toContain('Theirs'); expect(h).toContain('Mine'); expect(h).toMatch(/<p>Joseph K\. saved a newer version at \d{2}:\d{2} \S+\. Compare it with your version, then choose what to keep\.<\/p>/);
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(h).toMatch(new RegExp(`<h3[^>]*tabindex="-1"[^>]*>${esc(DECISION_FORM_COPY.conflict.heading)}</h3>`, 'i'));
    expect(h).toContain(DECISION_FORM_COPY.conflict.saved(2));   // which version is the saved one (the unit case pins it too)
    expect([...h.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual([DECISION_FORM_COPY.conflict.saveMine, DECISION_FORM_COPY.conflict.editMine, DECISION_FORM_COPY.conflict.discardMine]);
  });

  it('answer cost: ConflictView: reason null shows no \'erased\' text, and an erased reason still shows the erased line', () => {
    const none = renderToStaticMarkup(<ConflictView current={{ ...V2, reason: null, reasonErased: null }} mine={{ ...EMPTY, reason: 'Mine' }} viewerId="u-me" onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(none).not.toContain(DECISION_FORM_COPY.conflict.erased);
    expect(none).not.toContain('Reason: </dt><dd><bdi>Theirs');
    const erased = renderToStaticMarkup(<ConflictView current={{ ...V2, reason: null, reasonErased: { erasedOn: '2026-11-01' } as never }} mine={{ ...EMPTY, reason: 'Mine' }} viewerId="u-me" onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(erased).toContain(DECISION_FORM_COPY.conflict.erased);
  });

  it('F3 UX-28: "Your answer" lists the restored draft\'s evidence the block cannot name, as Save mine will attach it', () => {
    const h = renderToStaticMarkup(<ConflictView current={V2} mine={{ ...EMPTY, reason: 'Mine' }} viewerId="u-me" mineEvidence={['memo.pdf']} mineKeptEvidence={2} onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(h).toContain('memo.pdf');
    expect(h).toContain(DECISION_OUTCOME_COPY.keptEvidence(2));
  });

  it('F10 FR-DEC-08: when the newer version is a withdrawal, the conflict view says so', () => {
    const h = renderToStaticMarkup(<ConflictView current={{ ...V2, status: 'withdrawn', withdrawalCode: 'duplicate', decidedBy: null, declaredDate: null }} mine={{ ...EMPTY, reason: 'Mine' }} viewerId="u-me" onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(h).toMatch(/Status: <\/dt><dd[^>]*><bdi>Withdrawn: Duplicate<\/bdi>/);
  });

  it('NFR-SEC-11: record text in the conflict view is text, never markup', () => {
    const h = renderToStaticMarkup(<ConflictView current={{ ...V2, reason: '<img src=x onerror=alert(1)>' }} mine={{ ...EMPTY, reason: '<script>alert(1)</script>' }} viewerId="u-me" onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(h).not.toContain('<img src=x'); expect(h).not.toContain('<script>');
  });
});

describe('S-12 regions', () => {
  it('FR-DEC-01 UX-31 UX-14: a viewer and an archived project get no form', async () => {
    const { stageFixture } = await import('../helpers/stageFixture');
    const viewer = renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, canWrite: false, viewer: { ...PANEL.viewer, role: 'viewer' } } , stage: stageFixture() }));
    expect(viewer).toContain(AUTHZ_COPY.decisionFormNote.viewer);
    expect(viewer).not.toMatch(/Save decision/);
    expect(viewer).not.toMatch(/<form/);
    expect(renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, canWrite: false, projectArchived: true } , stage: stageFixture() }))).not.toMatch(/<form/);
  });

  it('FR-CNT-08: S-12 shows the reworded line when the running wording differs', async () => {
    const { stageFixture } = await import('../helpers/stageFixture');
    const h = renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, current: V2, runningQuestion: { ...PANEL.question, expectedPractice: 'New wording.' }, contentSemver: '0.0.2-fixture' } , stage: stageFixture() }));
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const line = QUESTION_COPY.reworded.line.replaceAll("'", '&#x27;');
    expect(h).toContain(line);
    expect(h).toMatch(new RegExp(`<details[^>]*>\\s*<summary[^>]*>${esc(QUESTION_COPY.reworded.summary)}</summary>[\\s\\S]*Old wording\\.`));
    // SPEC-1 ruling: the page shows the running wording a new save re-confirms against; the disclosure, the
    // wording the current decision was answered against. Each text once.
    expect(h.match(/New wording\./g)).toHaveLength(1);
    expect(h.match(/Old wording\./g)).toHaveLength(1);
    // Plan 1C decision C1 (cut): the running wording is the guidance aside's; the earlier one is only in the disclosure.
    expect(h).toMatch(/<aside[^>]*data-region="guidance"[^>]*>[\s\S]*New wording\.[\s\S]*<\/aside>/);
    expect(h).toMatch(/<details[^>]*>(?:(?!<\/details>)[\s\S])*Old wording\./);
    const same = renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, current: V2 } , stage: stageFixture() }));
    expect(same).not.toContain(QUESTION_COPY.reworded.summary);
    expect(same).not.toContain(line);   // with the same wording there is no line (the property's own words), not only no summary
  });

  it('UX-42 W-3: one h1 for the question that takes focus, and Previous and Next go to the neighbouring questions', async () => {
    // Lane 1 Task 1: Previous and Next are the position strip's (under 1160px; the breadcrumb and the route column above
    // it), which needs the stage's data: each link is named by its question in words, its place and its status.
    const { stageFixture } = await import('../helpers/stageFixture');
    const data = { ...PANEL, position: { index: 1, total: 24, previousId: 'Q-PP-01', nextId: 'Q-PP-03' } };
    const h = renderToStaticMarkup(await QuestionPanelRegions({ data, stage: stageFixture({ marks: { 'Q-PP-01': 'done' } }) }));
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).toMatch(/<h1 id="question-heading" tabindex="-1"[^>]*>Have you evaluated whether AI is the right approach\?<\/h1><p[^>]*>Q-PP-01 \u00b7 Problem Formulation<\/p>/i);
    const links = [...h.matchAll(/<a class="position-strip__step[^"]*"[^>]*>[\s\S]*?<\/a>/g)].map((m) => m[0]);
    const named = (l: string) => l.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('href="/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01"');
    expect(named(links[0])).toMatch(/^Previous question: .+ \(question 1, Done\)$/);
    expect(links[1]).toContain('href="/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-03"');
    expect(named(links[1])).toMatch(/^Next question: .+ \(question 3, No decision\)$/);
    expect(h).toContain('<b><span class="position-strip__word">Question </span>2 of 24</b>');   // the position in words, not the question's code
    const first = renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' } }, stage: stageFixture() }));
    expect(first).not.toContain('Previous question');
  });

  it('FR-DEC-01 FR-DEC-03 (screen): with no version, Current decision reads "No decision yet."', () => {
    expect(renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={null} historyCount={0} historyHref="/h" seals={[]} isScopeQuestion={false} />)).toContain(QUESTION_COPY.current.none);
    const v2 = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={V2} historyCount={2} historyHref="/h" seals={[]} isScopeQuestion={false} />);
    expect(v2).not.toContain(QUESTION_COPY.current.none);
    expect(v2).toContain('Partly');
    expect(v2).toContain(QUESTION_COPY.current.version(2));
    expect(v2).toContain(`Decided by: ${deciderLabel({ kind: 'outside_role', role: 'principal_investigator' }, '', 'record')}, 12 Oct 2026.`);
    expect(v2).toMatch(/Entered by: Joseph K\. on 12 Oct 2026 at \d{2}:\d{2} \S+/);
    const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    expect(v2).toMatch(new RegExp(`<a[^>]*href="/h"[^>]*>${esc(QUESTION_COPY.current.history(2))}</a>`));
  });

  it('U12 (d): the current decision shows the version\'s reason and its evidence, or None, for every role', () => {
    const withBoth = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={{ ...V2, reason: 'We checked the sources.', evidence: [{ id: 'e1', kind: 'link', url: 'https://example.org/a', label: 'Audit report', fileName: null, mimeType: null, byteSize: null, erased: null } as never] }} historyCount={2} historyHref="/h" seals={[]} isScopeQuestion={false} />);
    expect(withBoth).toMatch(/<dt>Reason<\/dt><dd>We checked the sources\.<\/dd>/);
    expect(withBoth).toContain('Audit report');
    const none = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={{ ...V2, reason: null, evidence: [] }} historyCount={2} historyHref="/h" seals={[]} isScopeQuestion={false} />);
    expect(none).toMatch(/<dt>Evidence<\/dt><dd>None<\/dd>/);
    const erased = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={{ ...V2, reason: null, reasonErased: { erasedOn: '2026-11-01' } as never, evidence: [] }} historyCount={2} historyHref="/h" seals={[]} isScopeQuestion={false} />);
    expect(erased).toContain(textErasedLine('2026-11-01').replace(/'/g, '&#x27;'));
  });

  it('answer cost: CurrentDecision with reason null renders no Reason term', () => {
    const h = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={{ ...V2, reason: null, reasonErased: null, evidence: [] }} historyCount={2} historyHref="/h" seals={[]} isScopeQuestion={false} />);
    expect(h).not.toContain('<dt>Reason</dt>');
    expect(h).toMatch(/<dt>Evidence<\/dt><dd>None<\/dd>/);
  });

  it('answer cost: DecisionHistoryList: a version with reason null renders no Reason term, and an erased one keeps its line', async () => {
    const { DecisionHistoryList } = await import('@/components/decision/DecisionHistoryList');
    const none = renderToStaticMarkup(<DecisionHistoryList orgSlug="acme" entries={[{ version: { ...V2, reason: null, reasonErased: null }, wording: null, seals: [] }]} />);
    expect(none).not.toContain('<dt>Reason</dt>');
    expect(none).toContain('<dt>Entered by</dt>');
    const erased = renderToStaticMarkup(<DecisionHistoryList orgSlug="acme" entries={[{ version: { ...V2, reason: null, reasonErased: { erasedOn: '2026-11-01' } as never }, wording: null, seals: [] }]} />);
    expect(erased).toContain('<dt>Reason</dt>');
    expect(erased).toContain(textErasedLine('2026-11-01').replace(/'/g, '&#x27;'));
  });

  it('FR-DEC-08 (screen): a withdrawal as the current version reads as no decision, with its history link', () => {
    const w = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={{ ...V2, versionNumber: 3, status: 'withdrawn', withdrawalCode: 'duplicate', decidedBy: null, declaredDate: null }} historyCount={3} historyHref="/h" seals={[]} isScopeQuestion={false} />);
    expect(w).toContain(QUESTION_COPY.current.withdrawn('Duplicate'));
    expect(w).toContain(QUESTION_COPY.current.history(3));
    expect(w).not.toContain('ui-mark');
  });

  it('L5-11 amended (C3): the current decision shows what its version records, whatever the personal data answer says today', () => {
    const words = (html: string) => [...html.matchAll(/class="ui-mark__words"[^>]*>([^<]*)</g)].map((m) => m[1]);
    // a version recorded as Partly on a question the gate now removes still reads Partly (no gate input at all: a caller
    // that still passed the retired `gated` prop changes nothing)
    const partly = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={V2} historyCount={2} historyHref="/h" seals={[]} isScopeQuestion={false} {...({ gated: true } as object)} />);
    expect(words(partly)).toEqual([STATUS_MARK_COPY.partly]);
    // the personal data question's version reads its answer
    const answer = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={{ ...V2, status: null, scopeAnswer: 'no' } as never} historyCount={2} historyHref="/h" seals={[]} isScopeQuestion />);
    expect(words(answer)).toEqual([STATUS_MARK_COPY.scope_answered('no')]);
    // a withdrawn version has its words and no mark
    const withdrawn = renderToStaticMarkup(<CurrentDecision orgSlug="acme" current={{ ...V2, versionNumber: 3, status: 'withdrawn', withdrawalCode: 'duplicate', decidedBy: null, declaredDate: null }} historyCount={3} historyHref="/h" seals={[]} isScopeQuestion={false} />);
    expect(withdrawn).toContain(QUESTION_COPY.current.withdrawn('Duplicate'));
    expect(withdrawn).not.toContain('ui-mark');
  });
});

describe('drafts on this device', () => {
  it('NFR-PRIV-06 B10: a stored draft links only to an application path; a tampered href is shown as text', () => {
    expect(safeDraftHref({ href: '/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01' })).toBe('/orgs/acme/projects/p1/stages/pre-processing/questions/Q-PP-01');
    for (const bad of ['javascript:alert(1)', 'https://evil.example/x', '//evil.example/orgs/a/projects/b/c', '/orgs/a/projects/b/c?x=<script>', 42, undefined]) {
      expect(safeDraftHref({ href: bad })).toBeNull();
    }
    expect(safeDraftHref(null)).toBeNull();
  });
});

describe('S-12 answer form before hydration', () => {
  /** How many <fieldset ...disabled=""> elements enclose each position: 0 means the control is outside every one. */
  function disabledDepthAt(html: string, at: number): number {
    const stack: boolean[] = [];
    const re = /<fieldset([^>]*)>|<\/fieldset>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html)) !== null && m.index < at) {
      if (m[0].startsWith('</')) stack.pop(); else stack.push(/\bdisabled=""/.test(m[1]));
    }
    return stack.filter(Boolean).length;
  }

  it('F5 CR-3: the first markup holds every control of the form in a disabled fieldset, so nothing posts or uploads before hydration', () => {
    const h = renderToStaticMarkup(<DecisionForm data={PANEL} />);
    expect(h).toContain('<fieldset disabled=""');
    const at = (needle: RegExp) => { const m = needle.exec(h); expect(m, String(needle)).not.toBeNull(); return m!.index; };
    for (const control of [/<textarea[^>]*id="decision-reason"/, /<input[^>]*type="file"/, /<button[^>]*type="submit"[^>]*>Save decision/, /<input[^>]*type="radio"/]) {
      expect(disabledDepthAt(h, at(control)), String(control)).toBeGreaterThan(0);
    }
    expect(h.match(/type="submit"/g)).toHaveLength(1);
  });

  it('answer cost 4: the first markup says "today" and shows no Decided by select, so it does not depend on the device\'s date', () => {
    const h = renderToStaticMarkup(<DecisionForm data={PANEL} />);
    expect(h).toContain('Decided by you, today');
    expect(h).not.toContain('id="decision-decided-by"');
    expect(h).not.toContain('id="decision-day"');
  });

  it('answer cost 4: an untouched form with defaults has no unsaved changes, with the device\'s today in it or not', async () => {
    const { answerDiffers } = await import('@/components/decision/DecisionForm');
    const today = { day: '22', month: '11', year: '2026' };
    const data = { ...PANEL, current: V2 };
    expect(answerDiffers(draftFromCurrent(data, today), data, today)).toBe(false);
    expect(answerDiffers(draftFromCurrent(data, null), data, null)).toBe(false);
    // a typed change still counts: another day than the default is a different answer
    expect(answerDiffers({ ...draftFromCurrent(data, today), date: { day: '3', month: '11', year: '2026' }, whoWhenChanged: true }, data, today)).toBe(true);
    expect(answerDiffers({ ...draftFromCurrent(data, today), reason: 'More.' }, data, today)).toBe(true);
  });
});
