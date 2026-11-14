import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionVersionView, EvidenceItemView } from '@/types/api';

/**
 * How S-12's answer form carries evidence. The attach component of plan 1c that this file first tested
 * (`components/evidence/EvidenceAttach.tsx`) was imported by nothing and is deleted with its helper (defect 25);
 * `__tests__/lint/no-dead-evidence.test.ts` keeps it out of the tree.
 */

// ---------------------------------------------------------------------------
// DecisionForm -- EvidenceBlock wiring (round 11b, R11-25). The Likert
// question block that used to carry EvidenceAttach had no production caller
// after the score removal, and is deleted; S-12's answer form now carries
// EVD's EvidenceBlock (contract "The S-12 shell"). These cases prove the form
// hands the block exactly what the panel gives it, with no re-derivation.
// The block is replaced by a stub that records its props; renderToStaticMarkup
// runs the form's hooks but not its effects.
// ---------------------------------------------------------------------------

type BlockProps = React.ComponentProps<typeof import('@/components/evidence/EvidenceBlock').EvidenceBlock>;
const blockProps = vi.hoisted(() => [] as unknown[]) as BlockProps[];   // the vi.hoisted pattern: the mock factory runs before module-level consts
vi.mock('@/components/evidence/EvidenceBlock', () => ({ EvidenceBlock: (p: unknown) => { blockProps.push(p as BlockProps); return <i data-evidence-block />; } }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh() {} }) }));

const EVIDENCE = [
  { id: 'e1', kind: 'file', fileName: 'memo.pdf', mimeType: 'application/pdf', byteSize: 412, sha256: 'a', url: null, label: null, uploadedBy: null, uploadedAt: '2026-10-12T07:00:00.000Z', erased: null },
  { id: 'e2', kind: 'link', fileName: null, mimeType: null, byteSize: null, sha256: null, url: 'https://drive.example.org/x', label: 'Cost notes', uploadedBy: null, uploadedAt: '2026-10-12T07:00:00.000Z', erased: null },
] as EvidenceItemView[];
const V2 = {
  id: 'dv2', projectId: 'p1', stage: 'pre-processing', questionId: 'Q-PP-01', versionNumber: 2, baseVersionNumber: 1,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'partly', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: 'Theirs', reasonErased: null, decidedBy: { kind: 'outside_role', role: 'supervisor' },
  declaredDate: '2026-10', declaredPrecision: 'month', withdrawalCode: null, enteredBy: { userId: 'u-j', name: 'Joseph K.', formerMember: false },
  enteredByRole: 'assessor', receivedAt: '2026-10-12T07:42:00.000Z', evidence: EVIDENCE,
} as DecisionVersionView;
const PANEL_WITH_V2: QuestionPanelData = {
  orgSlug: 'org-a', projectId: 'p1', projectArchived: false, stage: 'pre-processing',
  question: { id: 'Q-PP-01', type: 'likert-5', text: 't', principle: 'p', gaps: [], expectedPractice: 'e', whyAsked: 'w', reasonPrompt: 'r', evidenceExamples: [], stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0 },
  runningQuestion: { id: 'Q-PP-01', type: 'likert-5', text: 't', principle: 'p', gaps: [], expectedPractice: 'e', whyAsked: 'w', reasonPrompt: 'r', evidenceExamples: [], stage: 'pre-processing', moduleId: 'M1', moduleTitle: 'Problem Formulation', order: 0 },
  position: { index: 0, total: 24, previousId: null, nextId: 'Q-PP-02' }, current: V2, historyCount: 2, seals: [], reasonCodes: [],
  members: [], viewer: { userId: 'u-me', name: 'Amina N.', role: 'assessor' }, canWrite: true, canRaiseFinding: true,
  lastOwnSaveDate: null, openFinding: null, gateAnswer: null, contentSemver: '0.0.1-fixture', orgId: 'o1',
};
const { DecisionForm } = await import('@/components/decision/DecisionForm');
const renderForm = (over: Partial<QuestionPanelData> = {}) => {
  blockProps.length = 0;
  const html = renderToStaticMarkup(<DecisionForm data={{ ...PANEL_WITH_V2, ...over }} />);
  return { html, props: blockProps[0] };
};

describe('DecisionForm -- EvidenceBlock wiring', () => {
  it('FR-DEC-07 UX-30: renders exactly one EvidenceBlock, inside the form', () => {
    const { html } = renderForm();
    expect(blockProps).toHaveLength(1);
    expect(html).toMatch(/<form[^>]*>[\s\S]*data-evidence-block[\s\S]*<\/form>/);
  });

  it('FR-DEC-07: passes orgSlug, projectId and the current version\'s evidence (by reference) straight through, with no re-derivation', () => {
    const { props } = renderForm();
    expect(props.orgSlug).toBe(PANEL_WITH_V2.orgSlug);
    expect(props.projectId).toBe(PANEL_WITH_V2.projectId);
    expect(props.initial).toBe(PANEL_WITH_V2.current!.evidence);   // reference equality: the form does not filter or copy
    expect(props.fromVersionNumber).toBe(2);
    expect(props.disabled).toBe(false);
  });

  it('FR-DEC-07: passes only the contract\'s props to EvidenceBlock', () => {
    const { props } = renderForm();
    // `saveOut` and `unaddedLinkRefusals` joined the contract on 14 November 2026: the form tells the block that its save is
    // out (nothing is added meanwhile) and that it refused a save for an address typed and not added (the block says so at the box).
    const allowed = ['orgSlug', 'projectId', 'initial', 'disabled', 'onChange', 'onUploadState', 'onItemsChange', 'notUploaded', 'fromVersionNumber', 'saveOut', 'unaddedLinkRefusals'];
    expect(Object.keys(props).filter((k) => !allowed.includes(k))).toEqual([]);
  });

  it('on open no save is out and no save has been refused for an address typed and not added', () => {
    const { props } = renderForm();
    expect(props.saveOut).toBe(false);
    expect(props.unaddedLinkRefusals).toBe(0);
  });

  it('UX-14: a role that cannot record a decision gets no form and so no evidence block to change', () => {
    const { html } = renderForm({ canWrite: false, viewer: { userId: 'u-v', name: 'V', role: 'viewer' } });
    expect(blockProps).toHaveLength(0);
    expect(html).not.toMatch(/<form/);
  });
});

it('R11-25: QuestionBlock is deleted and nothing imports it', () => {
  const path = 'components/assessment/' + 'QuestionBlock';   // split, so this file does not match its own grep
  expect(existsSync(`${path}.tsx`)).toBe(false);
  expect(spawnSync('git', ['grep', '-n', path, '--', 'app', 'components', 'lib', '__tests__']).stdout.toString()).toBe('');   // spawnSync does not throw on git grep's exit 1 (no match)
});
