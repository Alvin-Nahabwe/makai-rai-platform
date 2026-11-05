import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionDraft } from '@/lib/question/draft';
import type { LoadedQuestion } from '@/types/content';
import type { DecisionVersionView } from '@/types/api';
import { gateStatus } from '@/lib/question/saveOutcome';

/**
 * The S-12 regions DEC-b fills (W-3, W-4; UX-09 to UX-12, UX-25, UX-28; NFR-A11Y-03, NFR-A11Y-04), rendered as
 * static markup: hooks run, effects do not, so this is the first markup a browser receives.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));

const { DecisionFields } = await import('@/components/decision/DecisionFields');
const { SaveStatus } = await import('@/components/decision/SaveStatus');
const { ConflictView } = await import('@/components/decision/ConflictView');
const { CurrentDecision } = await import('@/components/decision/CurrentDecision');
const { draftFromCurrent } = await import('@/lib/question/draft');
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
  position: { index: 1, total: 24, previousId: 'Q-PP-00', nextId: 'Q-PP-02' }, current: null, historyCount: 0, seals: [],
  reasonCodes: [
    { code: 'ny_planned_later', status: 'not_yet', label: 'Planned for later', useWhen: '', reasonMustSay: '' },
    { code: 'na_other', status: 'not_applicable', label: 'Other reason', useWhen: '', reasonMustSay: '' },
  ],
  members: [{ userId: 'u-j', name: 'Joseph K.' }], viewer: { userId: 'u-me', name: 'Amina N.', role: 'assessor' },
  canWrite: true, canRaiseFinding: true, lastOwnSaveDate: null, openFinding: null, gateAnswer: null,
  contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const EMPTY: DecisionDraft = draftFromCurrent(PANEL);

const html = (p: Partial<QuestionPanelData> = {}, v: Partial<DecisionDraft> = {}) =>
  renderToStaticMarkup(<DecisionFields data={{ ...PANEL, ...p }} value={{ ...EMPTY, ...v }} errors={[]} disabled={false} onChange={() => {}} />);

describe('S-12 decision fields', () => {
  it('UX-09: a native radio group named Status, four options in order, the finding note, and the reason code only with Not applicable or Not yet', () => {
    const h = html();
    expect(h).toMatch(/<fieldset[^>]*>\s*<legend[^>]*>Status<\/legend>/);
    expect([...h.matchAll(/<input[^>]*type="radio"[^>]*value="([a-z_]+)"/g)].map((m) => m[1])).toEqual(['done', 'partly', 'not_yet', 'not_applicable']);
    expect(h).toContain("Saving &#x27;Partly&#x27; or &#x27;Not yet&#x27; keeps a finding open for this question, or opens one.");
    expect(h).not.toContain('Reason code (required)');
    const ny = html({}, { status: 'not_yet' });
    expect(ny).toContain('Reason code (required)');
    expect(ny).toContain('Planned for later');
    expect(ny).not.toContain('Other reason');   // the codes of the chosen status only
  });

  it('UX-10 FR-DEC-10 NFR-A11Y-04: the date fields are empty on open; Same as version N is offered beside Today, not filled in', () => {
    const data = { ...PANEL, current: V2, lastOwnSaveDate: '2026-10' };
    const h = html({ current: V2, lastOwnSaveDate: '2026-10' }, draftFromCurrent(data));
    const dateInputs = [...h.matchAll(/<input[^>]*inputmode="numeric"[^>]*>/gi)];
    expect(dateInputs).toHaveLength(3);
    expect(dateInputs.every((m) => !/value="[^"]+"/.test(m[0]))).toBe(true);
    expect(h).toContain('Starting from version 2');
    expect(h).toMatch(/<button[^>]*>Today<\/button>/);
    expect(h).toMatch(/<button[^>]*>Same as version 2 \(12 Oct 2026\)<\/button>/);
    expect(h).toMatch(/<button[^>]*>Same as my last save: Oct 2026<\/button>/);
    expect(html({ current: null, lastOwnSaveDate: null })).not.toMatch(/Same as/);
  });

  it('FR-DEC-01: a new version opens from the current version\'s fields, and a withdrawal opens an empty form', () => {
    const d = draftFromCurrent({ ...PANEL, current: V2 });
    expect(d).toMatchObject({ status: 'partly', reason: 'Theirs', decidedBy: { kind: 'outside_role', role: 'principal_investigator' }, date: { day: '', month: '', year: '' } });
    expect(draftFromCurrent({ ...PANEL, current: { ...V2, status: 'withdrawn', reason: 'x', withdrawalCode: 'duplicate', decidedBy: null } }))
      .toMatchObject({ status: null, reason: '', decidedBy: { kind: 'member', userId: 'u-me' } });
  });

  it('UX-11: Decided by lists You first, then members, then the Outside roles group', () => {
    const h = html({ viewer: { userId: 'u-me', name: 'Amina N.', role: 'assessor' }, members: [{ userId: 'u-j', name: 'Joseph K.' }] });
    expect(h).toMatch(/<option[^>]*>You \(Amina N\.\)<\/option>\s*<option[^>]*>Joseph K\.<\/option>\s*<optgroup label="Outside roles">\s*<option[^>]*>Principal investigator<\/option>/);
  });

  it('UX-12: the reason helper and the count in text, linked to the field', () => {
    const h = html({}, { reason: 'x'.repeat(212) });
    expect(h).toContain('212 / 4,000 characters');
    expect(h).toMatch(/<textarea[^>]*aria-describedby="[^"]*reason-help[^"]*"/);
    expect(h).toContain('Say what is in place, where it is recorded, and what is missing.');
  });

  it('FR-CNT-04 FR-CNT-03 (screen): the gate takes a scope answer, a checklist its options with the count in text', () => {
    const gate = html({ question: { ...QUESTION, id: 'Q-PP-GATE-SENSITIVE', type: 'gate' } });
    expect(gate).toMatch(/<legend[^>]*>Scope answer \(required\)<\/legend>/);
    expect(gate).not.toMatch(/<legend[^>]*>Status<\/legend>/);
    expect(gate).toContain('This answer decides whether Q-PP-13 and Q-PP-14 apply. It does not open a finding.');
    const list = html({ question: { ...QUESTION, id: 'Q-PP-16', type: 'checklist', options: ['A', 'B', 'C'] } }, { optionsInPlace: ['B'] });
    expect(list).toMatch(/<legend[^>]*>Which of these are in place\?<\/legend>/);
    expect([...list.matchAll(/type="checkbox"/g)]).toHaveLength(3);
    expect(list).toContain('1 of 3 in place');
    expect(list).toMatch(/<legend[^>]*>Status<\/legend>/);
  });

  it('M-11 NFR-A11Y-03: a field error is next to its field and linked to it', () => {
    const h = renderToStaticMarkup(<DecisionFields data={PANEL} value={EMPTY} errors={[{ field: 'reason', message: 'Write a reason.' }]} disabled={false} onChange={() => {}} />);
    expect(h).toMatch(/<textarea[^>]*aria-invalid="true"/);
    expect(h).toMatch(/<textarea[^>]*aria-describedby="[^"]*decision-reason-error/);
    expect(h).toMatch(/id="decision-reason-error"[^>]*>Write a reason\.</);
  });
});

describe('S-12 status line and conflict view', () => {
  it('NFR-A11Y-03 UX-25: the status line has an empty polite and an empty assertive region from the first render', () => {
    const h = renderToStaticMarkup(<SaveStatus status={null} draftSavedAt={null} storageUnavailable={false} />);
    expect(h).toMatch(/role="status"[^>]*><\/[a-z]+>/);
    expect(h).toMatch(/role="alert"[^>]*><\/[a-z]+>/);
    expect(renderToStaticMarkup(<SaveStatus status={null} draftSavedAt={null} storageUnavailable />)).toContain('This browser cannot keep drafts. Save before leaving this page.');
    const failed = renderToStaticMarkup(<SaveStatus status={{ id: 'M-05', text: 'Not saved: connection lost. Your answer is kept on this device. Retry.', live: 'assertive', next: 'retry' }} draftSavedAt={null} storageUnavailable={false} />);
    expect(failed).toMatch(/role="status"[^>]*><\/[a-z]+>/);
    expect(failed).toMatch(/role="alert"[^>]*>Not saved: connection lost\./);
  });

  it('F4 UX-26: when the browser cannot keep drafts, the failure the screen reader hears says so too', () => {
    const h = renderToStaticMarkup(<SaveStatus status={{ id: 'M-05', text: 'Not saved: connection lost. Your answer is kept on this device. Retry.', live: 'assertive', next: 'retry' }} draftSavedAt={null} storageUnavailable />);
    expect(h).toMatch(/role="alert"[^>]*>Not saved: connection lost\. Your answer is kept on this device\. Retry\. This browser cannot keep drafts\. Save before leaving this page\.</);
    expect(h.match(/This browser cannot keep drafts/g)).toHaveLength(1);
  });

  it('CR-2 UX-26: a gate alert with no storage is the gate line alone, without "Save before leaving this page"', () => {
    for (const nav of [{ kind: 'go' as const, href: '/acceptances?callbackUrl=%2Fq' }, { kind: 'go' as const, href: '/change-password?callbackUrl=%2Fq' }]) {
      const gate = gateStatus(nav);
      const h = renderToStaticMarkup(<SaveStatus status={gate} draftSavedAt={null} storageUnavailable />);
      expect(h).toMatch(new RegExp(`role="alert"[^>]*>${gate.text.replace(/[.]/g, '\\.')}</`));
      expect(h).not.toContain('This browser cannot keep drafts');
    }
  });

  it('CR-1 ruling 5 UX-25: after a save that the person typed past, the line says Saved and also that a newer draft is on the device', () => {
    const h = renderToStaticMarkup(<SaveStatus status={{ id: 'M-03', text: 'Saved as version 1 at 10:42 EAT. Decided by: you. Entered by: you.', live: 'polite', next: 'none' }} draftSavedAt="2026-10-12T07:43:00.000Z" storageUnavailable={false} />);
    expect(h).toMatch(/role="status"[^>]*>Saved as version 1 at 10:42 EAT\./);
    expect(h).toMatch(/Draft on this device, not saved yet \(\d{2}:\d{2} \S+\)/);
    // with no newer draft, "Saved" stands alone
    expect(renderToStaticMarkup(<SaveStatus status={{ id: 'M-03', text: 'Saved as version 1 at 10:42 EAT.', live: 'polite', next: 'none' }} draftSavedAt={null} storageUnavailable={false} />)).not.toContain('Draft on this device');
  });

  it('UX-28 M-10: the conflict view shows both reasons, who saved, and the three actions', () => {
    const h = renderToStaticMarkup(<ConflictView current={{ ...V2, reason: 'Theirs' }} mine={{ ...EMPTY, reason: 'Mine' }} viewerId="u-me" onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(h).toContain('Theirs'); expect(h).toContain('Mine'); expect(h).toContain('Version 2 was saved by Joseph K.');
    expect(h).toMatch(/<h3[^>]*tabindex="-1"[^>]*>Not saved: someone saved a newer version\.<\/h3>/i);
    expect([...h.matchAll(/<button[^>]*>([^<]+)<\/button>/g)].map((m) => m[1])).toEqual(['Save mine as version 3', 'Edit mine first', 'Discard mine']);
  });

  it('F3 UX-28: "Your answer" lists the restored draft\'s evidence the block cannot name, as Save mine will attach it', () => {
    const h = renderToStaticMarkup(<ConflictView current={V2} mine={{ ...EMPTY, reason: 'Mine' }} viewerId="u-me" mineEvidence={['memo.pdf']} mineKeptEvidence={2} onSaveMine={() => {}} onEditMine={() => {}} onDiscard={() => {}} />);
    expect(h).toContain('memo.pdf');
    expect(h).toContain('This answer also holds 2 evidence items added before the page was closed. It is attached when you save.');
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
    const viewer = renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, canWrite: false, viewer: { ...PANEL.viewer, role: 'viewer' } } }));
    expect(viewer).toContain('Only owners, admins and assessors record decisions.');
    expect(viewer).not.toMatch(/Save decision/);
    expect(viewer).not.toMatch(/<form/);
    expect(renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, canWrite: false, projectArchived: true } }))).not.toMatch(/<form/);
  });

  it('FR-CNT-08: S-12 shows the reworded line when the running wording differs', async () => {
    const h = renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, current: V2, runningQuestion: { ...PANEL.question, expectedPractice: 'New wording.' }, contentSemver: '0.0.2-fixture' } }));
    expect(h).toContain('Wording updated in content version 0.0.2-fixture.');
    expect(h).toMatch(/<details[^>]*>\s*<summary[^>]*>See the earlier wording<\/summary>[\s\S]*Old wording\./);
    // SPEC-1 ruling: the question region shows the running wording a new save re-confirms against; the disclosure, the
    // wording the current decision was answered against. Each text once.
    expect(h.match(/New wording\./g)).toHaveLength(1);
    expect(h.match(/Old wording\./g)).toHaveLength(1);
    expect(h.indexOf('New wording.')).toBeLessThan(h.indexOf('See the earlier wording'));
    expect(renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, current: V2 } }))).not.toContain('Wording updated');
  });

  it('UX-42 W-3: one h1 for the question that takes focus, and Previous and Next go to the neighbouring questions', async () => {
    const h = renderToStaticMarkup(await QuestionPanelRegions({ data: PANEL }));
    expect(h.match(/<h1/g)).toHaveLength(1);
    expect(h).toMatch(/<h1 id="question-heading" tabindex="-1"[^>]*>Q-PP-01 \. Problem Formulation<\/h1>/i);
    expect(h).toMatch(/<a[^>]*href="\/orgs\/acme\/projects\/p1\/stages\/pre-processing\/questions\/Q-PP-00"[^>]*>Previous question<\/a>/);
    expect(h).toMatch(/<a[^>]*href="\/orgs\/acme\/projects\/p1\/stages\/pre-processing\/questions\/Q-PP-02"[^>]*>Next question<\/a>/);
    expect(h).toContain('Question 2 of 24 in Pre-processing');   // the stage's name, not its address segment (CR-7)
    expect(renderToStaticMarkup(await QuestionPanelRegions({ data: { ...PANEL, position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' } } }))).not.toContain('Previous question');
  });

  it('FR-DEC-01 FR-DEC-03 (screen): with no version, Current decision reads "No decision yet."', () => {
    expect(renderToStaticMarkup(<CurrentDecision current={null} historyCount={0} historyHref="/h" seals={[]} />)).toContain('No decision yet.');
    const v2 = renderToStaticMarkup(<CurrentDecision current={V2} historyCount={2} historyHref="/h" seals={[]} />);
    expect(v2).not.toContain('No decision yet.');
    expect(v2).toContain('Partly');
    expect(v2).toContain('version 2');
    expect(v2).toContain('Decided by: Principal investigator (outside role), 12 Oct 2026.');
    expect(v2).toMatch(/Entered by: Joseph K\., 12 Oct 2026 \d{2}:\d{2} \S+/);
    expect(v2).toMatch(/<a[^>]*href="\/h"[^>]*>History: 2 versions<\/a>/);
  });

  it('FR-DEC-08 (screen): a withdrawal as the current version reads as no decision, with its history link', () => {
    const w = renderToStaticMarkup(<CurrentDecision current={{ ...V2, versionNumber: 3, status: 'withdrawn', withdrawalCode: 'duplicate', decidedBy: null, declaredDate: null }} historyCount={3} historyHref="/h" seals={[]} />);
    expect(w).toContain('No decision. Version 3 withdrew the decision: Duplicate.');
    expect(w).toContain('History: 3 versions');
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
});
