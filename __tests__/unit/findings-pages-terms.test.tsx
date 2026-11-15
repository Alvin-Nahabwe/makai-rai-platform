import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FindingsPageView } from '@/components/findings/FindingsPageView';
import { FindingPageView } from '@/components/findings/FindingPageView';
import { REVIEW_COPY } from '@/lib/review/copy';
import type { MitigationVersionView } from '@/types/api';
import { FINDINGS_COPY } from '@/lib/findings/copy';
import type { FindingListItem, FindingPageData, FindingsPageData } from '@/lib/findings/pageData';
import {
  TERM_ACCEPTED_RISK, TERM_DOES_NOT_APPLY, TERM_FINDING, TERM_MITIGATION, TERM_NOT_YET, TERM_PARTLY, TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION,
  TERM_RISK_AREA, TERM_STAGE_1, TERM_STAGE_2,
} from '@/lib/vocabulary/terms';
import { firstUseProblems } from '../helpers/firstUseHtml';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {}, push() {} }) }));

/**
 * Lane 6, B4: first-use definitions on the findings list (S-14), every query variant (spec 6; definitions-howto.md):
 * "Findings" in the heading, mitigation under it (as the findings sketch does), each stage's meaning under its group
 * heading, and risk area beside the raise form's field.
 */

const esc = (s: string) => s.replaceAll('&', '&amp;').replaceAll("'", '&#x27;').replaceAll('"', '&quot;');

const row = (over: Partial<FindingListItem> = {}): FindingListItem => ({
  id: 'f1', stage: 'pre-processing', title: 'Labels are inconsistent', sourceLabel: FINDINGS_COPY.labels.raisedByTeam, sourceStatus: null,
  stateLabel: FINDINGS_COPY.labels.open, state: 'open', decisionVersionId: null, closeReason: null, openMitigations: 0, overdueMitigations: 0,
  raisedAt: '2026-11-15T07:00:00.000Z', ...over,
});

const data = (over: Partial<FindingsPageData> = {}): FindingsPageData => ({
  orgSlug: 'o', orgId: 'org', projectId: 'p', projectName: 'Triage model', archived: false, userId: 'u', stageFilter: null,
  canRaise: true, canClose: true, shown: null, empty: false, decisionDone: [], decisionWithdrawn: [], gateNo: [],
  stages: [{ stage: 'pre-processing', name: 'Pre-processing', heading: 'Pre-processing: 1 finding', count: 1, noMitigation: [row()], overdue: [], other: [] }],
  lookAgain: [], closed: [], withdrawn: [],
  raise: { areas: { 'pre-processing': [{ id: 'RA-01', name: 'Unfair results' }], 'in-processing': [], 'post-processing': [] }, prefill: null },
  ...over,
});

const page = (d: FindingsPageData) => renderToStaticMarkup(<FindingsPageView data={d} />);

describe('S-14 first-use definitions', () => {
  it('the heading holds "Findings"; finding and mitigation are defined under it, mitigation before "Open, no mitigation yet"', () => {
    const out = page(data());
    expect(out).toContain(`<h1 class="ui-page-header__title" aria-describedby="findings-term-finding"><span data-term="finding">${FINDINGS_COPY.titles.findings}</span></h1>`);
    expect(out).toContain(`<dt>Finding</dt><dd><span class="ui-definition" id="findings-term-finding" data-definition="finding">${esc(TERM_FINDING.definition)}</span></dd>`);
    expect(out).toContain(`<dt><span data-term="mitigation">Mitigation</span></dt><dd><span class="ui-definition" id="findings-term-mitigation" data-definition="mitigation">${esc(TERM_MITIGATION.definition)}</span></dd>`);
    expect(out.indexOf('data-definition="mitigation"')).toBeLessThan(out.indexOf(FINDINGS_COPY.list.noMitigation));
    expect(firstUseProblems(out)).toEqual([]);
  });

  it('each stage group heading marks the stage, and its meaning follows the heading', () => {
    const out = page(data({ stages: [
      { stage: 'pre-processing', name: 'Pre-processing', heading: 'Pre-processing: 1 finding', count: 1, noMitigation: [row()], overdue: [], other: [] },
      { stage: 'in-processing', name: 'In-processing', heading: 'In-processing: 2 findings', count: 2, noMitigation: [], overdue: [], other: [row({ id: 'f2', stage: 'in-processing' }), row({ id: 'f3', stage: 'in-processing' })] },
    ] }));
    expect(out).toContain(`<h2 id="g-pre-processing"><span data-term="stage-1">Pre-processing</span>: 1 finding</h2><p class="ui-definition" data-definition="stage-1">${esc(TERM_STAGE_1.definition)}</p>`);
    expect(out).toContain(`<h2 id="g-in-processing"><span data-term="stage-2">In-processing</span>: 2 findings</h2><p class="ui-definition" data-definition="stage-2">${esc(TERM_STAGE_2.definition)}</p>`);
    expect(firstUseProblems(out)).toEqual([]);
  });

  it('the raise form\'s risk area label marks the term, its definition is the field\'s hint and describes the select', () => {
    const out = page(data());
    expect(out).toContain(`<label class="ui-field__label" for="riskArea"><span data-term="risk-area">${FINDINGS_COPY.raise.riskAreaWord}</span> ${FINDINGS_COPY.raise.optional}</label>`);
    expect(out).toContain(`<div class="ui-field__hint" id="riskArea-help"><span class="ui-definition" data-definition="risk-area">${esc(TERM_RISK_AREA.definition)}</span></div>`);
    expect(out).toMatch(/<select[^>]*id="riskArea"[^>]*aria-describedby="riskArea-help"/);
  });

  it('every query variant passes: a stage filter, the raise link (?raise=1&stage=&questionId=&versionId=), a viewer with no form', () => {
    expect(firstUseProblems(page(data({ stageFilter: 'pre-processing' })))).toEqual([]);
    const prefill = { stage: 'pre-processing' as const, questionId: 'Q-PP-04', questionText: 'Are the labels consistent?', versionId: 'v1', versionNumber: 1, areaIds: ['RA-01'] };
    expect(firstUseProblems(page(data({ raise: { ...data().raise!, prefill } })))).toEqual([]);
    expect(firstUseProblems(page(data({ raise: null, canRaise: false, canClose: false })))).toEqual([]);
    expect(firstUseProblems(page(data({ stages: [], empty: true })))).toEqual([]);
  });

  it('defines the decision statuses the rows show, and accepted risk when the page lists one', () => {
    const shortfall = row({ id: 'f9', sourceLabel: FINDINGS_COPY.labels.fromDecisionWith('Partly'), sourceStatus: 'partly' });
    const closed = row({ id: 'f8', state: 'closed_accepted_risk', stateLabel: FINDINGS_COPY.labels.closedByAcceptedRiskBy('Grace A.') });
    const out = page(data({ stages: [{ stage: 'pre-processing', name: 'Pre-processing', heading: 'Pre-processing: 1 finding', count: 1, noMitigation: [shortfall], overdue: [], other: [] }], closed: [closed] }));
    expect(out).toContain(`<dt><span data-term="partly">${TERM_PARTLY.term}</span></dt>`);
    expect(out).not.toContain('data-definition="not-yet"');
    expect(out).toContain(`<dt><span data-term="accepted-risk">Accepted risk</span></dt>`);
    expect(firstUseProblems(out)).toEqual([]);
    expect(page(data())).not.toContain('data-definition="accepted-risk"');
  });

  it('an empty project names Partly and Not yet in its sentence, so both are defined', () => {
    const out = page(data({ stages: [], empty: true }));
    expect(out).toContain(`<dt><span data-term="not-yet">${TERM_NOT_YET.term}</span></dt>`);
    expect(out).toContain('data-definition="partly"');
    expect(out).not.toContain(`data-definition="${TERM_ACCEPTED_RISK.id}"`);
  });
});

// ─── S-15, one finding ──────────────────────────────────────────────────────────────────────────────────────────
const user = { userId: 'u1', name: 'Grace A.', formerMember: false };
const mitigation = (over: Partial<MitigationVersionView> = {}): MitigationVersionView => ({
  id: 'mv1', findingId: 'f1', mitigationId: 'm1', versionNumber: 1, baseVersionNumber: null, what: 'Relabel the data', changeNote: null,
  owner: user, dueDate: '2026-12-01', status: 'planned', kind: 'action', followsControl: null, closureNote: null, closureDecisionVersionId: null,
  cancelReason: null, enteredBy: user, enteredByRole: 'assessor', findingSeq: 2, receivedAt: '2026-11-15T07:00:00.000Z', evidence: [], erasedFields: [], ...over,
});
const finding = (over: Partial<FindingPageData> = {}, detail: Partial<FindingPageData['detail']> = {}): FindingPageData => ({
  orgSlug: 'o', orgId: 'org', projectId: 'p', projectName: 'Triage model', archived: false, viewer: { userId: 'u1', name: 'Grace A.' },
  detail: {
    id: 'f1', projectId: 'p', stage: 'pre-processing', source: 'team', questionId: null, decisionVersionId: null, riskArea: null,
    title: 'Labels are inconsistent', description: null, raisedBy: user, raisedAt: '2026-11-15T07:00:00.000Z', state: 'open',
    openMitigations: 0, hasNoMitigation: true, overdueMitigations: 0, mitigations: [], acceptedRisk: null, acceptedRisks: [], events: [], seals: [], ...detail,
  },
  title: 'Labels are inconsistent', sourceLabel: FINDINGS_COPY.labels.raisedByTeam, stateLabel: FINDINGS_COPY.labels.open, questionText: null,
  version: null, contentSemver: '0.0.1-fixture', mitigations: [], closingRecords: [], closure: null, questionHref: null, ownerCannotAct: [],
  owners: [user], members: [user], controls: [], riskAreaName: null, closeByDecision: null, closeBlocked: false,
  canMitigate: false, canAccept: false, canReopen: false, canWithdraw: false, ...over,
});
const findingPage = (d: FindingPageData) => renderToStaticMarkup(<FindingPageView data={d} />);
/** The title the team typed: the browser spec skips a node that is wholly team text (ruling X-1 (3)). */
const TEAM = ['Labels are inconsistent'];

describe('S-15 first-use definitions', () => {
  it('"Back to findings" marks the term and names its definition, which sits under the heading with the page\'s other terms', () => {
    const out = findingPage(finding());
    expect(out).toContain('<p class="finding-back-line"><a class="finding-back" aria-describedby="finding-term-finding" href="/orgs/o/projects/p/findings">Back to <span data-term="finding">findings</span></a></p>');
    expect(out).toContain('<dt>Finding</dt><dd><span class="ui-definition" id="finding-term-finding" data-definition="finding">');
    expect(out).toContain('<dt><span data-term="stage-1">Pre-processing</span></dt>');
    expect(out).toContain('<dt><span data-term="mitigation">Mitigation</span></dt>');
    expect(out).not.toContain('data-definition="seal"'); expect(out).not.toContain('data-definition="risk-area"');
    expect(firstUseProblems(out, TEAM)).toEqual([]);
  });

  it('a finding in a seal defines seal; its marker stays plain (the stage is defined above it)', () => {
    const out = findingPage(finding({}, { seals: [{ sealId: 's1', sealNumber: 1, reviewId: 'r1', reviewName: 'Pre-processing review 1' }] }));
    expect(out).toContain('<dt><span data-term="seal">Seal</span></dt>');
    expect(out).toContain(`<li>${REVIEW_COPY.mounted.sealMarker(1, 'Pre-processing review 1')}</li>`);
    expect(firstUseProblems(out, TEAM)).toEqual([]);
  });

  it('a finding with a risk area, raised from a decision saved as Partly and now Done, defines risk area and both statuses', () => {
    const out = findingPage(finding({
      sourceLabel: FINDINGS_COPY.labels.fromDecisionWith('Partly'), version: { versionNumber: 1, status: 'partly', statusWord: 'Partly' }, riskAreaName: 'Unfair results',
      closeByDecision: { reason: 'decision_done', decisionVersionId: 'v2', questionId: 'Q-PP-04', versionNumber: 2, statusWord: 'Done', status: 'done' }, canMitigate: true,
    }, { source: 'shortfall', questionId: 'Q-PP-04', decisionVersionId: 'v1', riskArea: 'RA-01' }));
    for (const id of ['risk-area', 'partly', 'done']) expect(out).toContain(`data-definition="${id}"`);
    expect(firstUseProblems(out, TEAM)).toEqual([]);
  });

  it('a finding closed by an accepted risk defines accepted risk', () => {
    const accepted = { id: 'a1', findingId: 'f1', acceptedBy: { kind: 'member' as const, user }, accepterRole: 'owner' as const, reason: 'Committee minutes', lookAgainNote: null, lookAgainOn: null, enteredBy: user, enteredByRole: 'owner' as const, findingSeq: 3, receivedAt: '2026-11-15T08:00:00.000Z', erasedFields: [] };
    const out = findingPage(finding({ stateLabel: FINDINGS_COPY.labels.closedByAcceptedRiskBy('Grace A.') }, { state: 'closed_accepted_risk', acceptedRisk: accepted, acceptedRisks: [accepted] }));
    expect(out).toContain('<dt><span data-term="accepted-risk">Accepted risk</span></dt>');
    expect(firstUseProblems(out, [...TEAM, 'Committee minutes'])).toEqual([]);
  });

  // B4 I2: the gate cause sentences. A gate's version stores a scope answer and no status (decision_versions_answer_check),
  // so `status` is null for gate_no and the box defines no status.
  const gateShortfall = { source: 'shortfall' as const, questionId: 'Q-PP-09', decisionVersionId: 'v1' };
  const gateClosing = { reason: 'gate_no' as const, decisionVersionId: 'g1', questionId: 'Q-PP-GATE-SENSITIVE', versionNumber: 1, statusWord: '', status: null };
  const PDQ = TERM_PERSONAL_DATA_QUESTION_SCOPE_QUESTION;
  const NOT_STATUSES = ['done', 'partly', 'not-yet', 'not-applicable'];

  it('the gate_no close box defines the personal data question and Does not apply, and no status', () => {
    const out = findingPage(finding({ closeByDecision: gateClosing, canMitigate: true }, gateShortfall));
    expect(out).toContain(FINDINGS_COPY.finding.closeGate);
    expect(out).toContain(`<dt><span data-term="${PDQ.id}">The personal data question</span></dt>`);
    expect(out).toContain(`<dt><span data-term="${TERM_DOES_NOT_APPLY.id}">Does not apply</span></dt>`);
    for (const id of NOT_STATUSES) expect(out).not.toContain(`data-definition="${id}"`);
    expect(firstUseProblems(out, TEAM)).toEqual([]);
  });

  it('the blocked gate_no box (its cause alone) defines the same two terms', () => {
    const out = findingPage(finding({ closeByDecision: gateClosing, closeBlocked: true, canMitigate: true }, gateShortfall));
    expect(out).toContain(FINDINGS_COPY.finding.closeGateCause);
    expect(out).toContain(`data-definition="${PDQ.id}"`);
    expect(out).toContain(`data-definition="${TERM_DOES_NOT_APPLY.id}"`);
    // Left for the lead (FX2 report): the blocked line's "Mark the mitigation Done" is a mitigation status, read as the
    // decision status Done (X-1 (1), as B4 review M2); it is not a gate term.
    expect(firstUseProblems(out, TEAM)).toEqual([{ id: 'done', text: FINDINGS_COPY.finding.closeBlocked }]);
  });

  it('a finding closed because the question no longer applies defines the personal data question (not Does not apply)', () => {
    for (const closedBy of [null, { by: 'Grace A.', at: '2026-11-15T08:00:00.000Z' }]) {
      const out = findingPage(finding({ stateLabel: FINDINGS_COPY.labels.closed, closure: { closedBy, cause: 'no_longer_applies' } }, { ...gateShortfall, state: 'closed_mitigation' }));
      expect(out).toContain(esc(FINDINGS_COPY.mitigation.closedBecauseNoLongerApplies));
      expect(out).toContain(`data-definition="${PDQ.id}"`);
      expect(out).not.toContain(`data-definition="${TERM_DOES_NOT_APPLY.id}"`);
      expect(firstUseProblems(out, TEAM)).toEqual([]);
    }
  });

  it('a close by a changed decision defines neither gate term', () => {
    const out = findingPage(finding({ closeByDecision: { ...gateClosing, reason: 'decision_done', statusWord: 'Done', status: 'done' }, canMitigate: true }, gateShortfall));
    expect(out).not.toContain(`data-definition="${PDQ.id}"`);
    expect(out).not.toContain(`data-definition="${TERM_DOES_NOT_APPLY.id}"`);
  });
});

describe('F7: the cancel reason an acceptance writes', () => {
  it('shows the stored "risk accepted" of earlier rows in the new words, and the new words as they are', () => {
    const card = (cancelReason: string) => findingPage(finding({ mitigations: [{ current: mitigation({ status: 'cancelled', cancelReason }), versions: 2, history: [], overdue: false }] }));
    const shown = `${FINDINGS_COPY.mitigation.cancelReason} <bdi>${esc(FINDINGS_COPY.mitigation.riskAcceptedCancel)}</bdi>`;
    expect(card('risk accepted')).toContain(shown);
    expect(card(FINDINGS_COPY.mitigation.riskAcceptedCancel)).toContain(shown);
    expect(card('Budget moved to Q2')).toContain(`${FINDINGS_COPY.mitigation.cancelReason} <bdi>Budget moved to Q2</bdi>`);
    expect(FINDINGS_COPY.mitigation.riskAcceptedCancel).toBe('The risk was accepted, so this work was cancelled.');
  });
});
