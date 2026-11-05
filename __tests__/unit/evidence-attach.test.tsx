import { describe, it, expect, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import type React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { join } from 'node:path';
import type { ReactElement, ReactNode } from 'react';
import {
  EvidenceAttach,
  formatBytes,
  MAX_UPLOAD_BYTES,
  type EvidenceAttachItem,
  type EvidenceAttachProps,
} from '@/components/evidence/EvidenceAttach';
import { MAX_BYTES } from '@/lib/evidence/inspect';
import type { QuestionPanelData } from '@/lib/question/panel';
import type { DecisionVersionView, EvidenceItemView } from '@/types/api';

/**
 * Plan 1c Task 10 (the attach UI). Same technique as
 * `__tests__/unit/report-provenance.test.tsx`: `EvidenceAttach` and
 * `QuestionBlock` are both plain function components with NO HOOKS (by
 * design — see EvidenceAttach.tsx's own module doc for why: this repo has
 * no jsdom/@testing-library/react/react-test-renderer, confirmed by
 * `package.json` and `vitest.config.ts`'s `environment: 'node'` — calling a
 * hook-bearing component directly outside a real renderer throws "Invalid
 * hook call", so staying hookless is what keeps a component in this
 * codebase unit-testable at all by direct invocation. Calling them directly
 * as functions returns the unrendered element tree; walking `.props` needs
 * no DOM.
 *
 * `extractText`/`findAll`/`findByTypeAndText` are local to this file, not
 * imported from report-provenance.test.tsx, matching that file's own
 * precedent of keeping this small helper local rather than shared.
 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractText).join('');
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const children = (node as ReactElement<{ children?: ReactNode }>).props?.children;
    return extractText(children ?? null);
  }
  return '';
}

/** Recursively collects every element in the tree matching `predicate`. */
function findAll(node: ReactNode, predicate: (el: ReactElement) => boolean, acc: ReactElement[] = []): ReactElement[] {
  if (node === null || node === undefined || typeof node === 'boolean') return acc;
  if (Array.isArray(node)) {
    node.forEach((n) => findAll(n, predicate, acc));
    return acc;
  }
  if (typeof node === 'object' && node !== null && 'props' in node) {
    const el = node as ReactElement<{ children?: ReactNode }>;
    if (predicate(el)) acc.push(el);
    findAll(el.props?.children ?? null, predicate, acc);
  }
  return acc;
}

function findByTypeAndText(node: ReactNode, type: string, text: string | RegExp): ReactElement | undefined {
  return findAll(node, (el) => {
    if (el.type !== type) return false;
    const t = extractText((el.props as { children?: ReactNode }).children);
    return typeof text === 'string' ? t.includes(text) : text.test(t);
  })[0];
}

const BASE_ITEMS: EvidenceAttachItem[] = [
  { id: 'ev-1', filename: 'bias-audit.pdf', byteSize: 234567, uploadedAt: '2026-08-06T12:00:00.000Z' },
];

const BASE_PROPS: EvidenceAttachProps = {
  questionId: 'Q-PP-01',
  orgSlug: 'org-a',
  items: BASE_ITEMS,
  loading: false,
  loadError: false,
  stale: false,
  canCreate: true,
  canDelete: true,
  busy: false,
  error: null,
  onUpload: () => {},
  onDelete: () => {},
};

describe('formatBytes', () => {
  it('formats sub-KB sizes in bytes', () => {
    expect(formatBytes(500)).toBe('500 B');
  });

  it('formats KB with one decimal', () => {
    expect(formatBytes(2048)).toBe('2.0 KB');
  });

  it('formats MB with one decimal', () => {
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('MAX_UPLOAD_BYTES', () => {
  it('equals the server-side limit lib/evidence/inspect.ts enforces -- duplicated deliberately, not imported: inspect.ts\'s module-scope SIGNATURES array calls Buffer.from(...) eagerly at import time, which would throw in this client component\'s browser bundle (verified no "buffer" polyfill dependency in package.json, no polyfill config in next.config.ts, and no other \'use client\' file in this repo references Buffer). This test is the coupling mechanism that catches drift instead of a shared import.', () => {
    expect(MAX_UPLOAD_BYTES).toBe(MAX_BYTES);
  });
});

describe('EvidenceAttach -- gating reflects, never makes, the authorization decision (mode: presence => absent, not merely disabled)', () => {
  it('renders "Attach evidence" when canCreate is true', () => {
    const tree = EvidenceAttach(BASE_PROPS);
    expect(findByTypeAndText(tree, 'button', 'Attach evidence')).toBeDefined();
  });

  it('renders no "Attach evidence" control anywhere in the tree when canCreate is false', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, canCreate: false });
    expect(findByTypeAndText(tree, 'button', 'Attach evidence')).toBeUndefined();
  });

  it('renders "Delete evidence" per item when canDelete is true', () => {
    const tree = EvidenceAttach(BASE_PROPS);
    expect(findByTypeAndText(tree, 'button', 'Delete evidence')).toBeDefined();
  });

  it('renders no "Delete evidence" control anywhere in the tree when canDelete is false', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, canDelete: false });
    expect(findByTypeAndText(tree, 'button', 'Delete evidence')).toBeUndefined();
  });

  it('renders "Download evidence" regardless of canCreate/canDelete -- evidence:read is universal, not gated by either', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, canCreate: false, canDelete: false });
    expect(findByTypeAndText(tree, 'a', 'Download evidence')).toBeDefined();
  });
});

describe('EvidenceAttach -- filename rendering (React escaping)', () => {
  const HOSTILE = '<img src=x onerror=alert(1)>"\'&.pdf';

  it('renders a hostile filename as literal text, unmodified -- never stripped, never interpreted', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: [{ ...BASE_ITEMS[0], filename: HOSTILE }] });
    expect(extractText(tree)).toContain(HOSTILE);
  });

  it('places the hostile filename as a scalar string child -- the exact mechanism React\'s default JSX-child escaping relies on (a text node, never innerHTML)', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: [{ ...BASE_ITEMS[0], filename: HOSTILE }] });
    const matches = findAll(tree, (el) => (el.props as { children?: unknown }).children === HOSTILE);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('never uses dangerouslySetInnerHTML as a prop in the component source -- the one API that would bypass React\'s default escaping', () => {
    const source = readFileSync(join(__dirname, '../../components/evidence/EvidenceAttach.tsx'), 'utf-8');
    // Matches actual JSX usage (`dangerouslySetInnerHTML={...}`), not the
    // API's name appearing in an explanatory comment -- the component's own
    // module doc names it deliberately (documenting what is NOT used), and
    // a plain substring check would fail on that comment's own honesty.
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/);
  });
});

describe('EvidenceAttach -- long filename layout', () => {
  it('applies an overflow-safe wrapping style to the filename so it cannot force horizontal overflow', () => {
    const long = 'a'.repeat(300) + '.pdf';
    const tree = EvidenceAttach({ ...BASE_PROPS, items: [{ ...BASE_ITEMS[0], filename: long }] });
    const node = findAll(tree, (el) => (el.props as { children?: unknown }).children === long)[0];
    expect(node).toBeDefined();
    const style = (node!.props as { style?: Record<string, unknown> }).style;
    expect(style?.overflowWrap ?? style?.wordBreak).toBeTruthy();
  });
});

describe('EvidenceAttach -- busy state', () => {
  it('disables the attach trigger and relabels it "Uploading…" while busy', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, busy: true });
    const btn = findByTypeAndText(tree, 'button', /Uploading/);
    expect(btn).toBeDefined();
    expect((btn!.props as { disabled?: boolean }).disabled).toBe(true);
  });

  it('disables each delete button while busy', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, busy: true });
    const btn = findByTypeAndText(tree, 'button', 'Delete evidence');
    expect((btn!.props as { disabled?: boolean }).disabled).toBe(true);
  });
});

describe('EvidenceAttach -- error and empty states', () => {
  it('shows the error message in a role=alert region when error is set', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, error: 'File too large' });
    const alert = findAll(tree, (el) => (el.props as { role?: string }).role === 'alert')[0];
    expect(alert).toBeDefined();
    expect(extractText(alert)).toContain('File too large');
  });

  it('shows no alert region when error is null', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, error: null });
    expect(findAll(tree, (el) => (el.props as { role?: string }).role === 'alert').length).toBe(0);
  });

  it('shows a confirmed-empty message for an empty list once loading has finished with no error', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: [], loading: false, loadError: false });
    expect(extractText(tree)).toMatch(/no evidence attached/i);
  });

  it('shows a distinct could-not-load message (not the confirmed-empty one) when the list failed to load -- an empty list must never be presented as a confirmed absence of evidence when it is actually unknown', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: [], loading: false, loadError: true });
    const text = extractText(tree);
    expect(text).toMatch(/could not be loaded/i);
    expect(text).not.toMatch(/no evidence attached/i);
  });

  /**
   * Fix round 1 (silent-failure-hunter / reviewer finding, Minor 1): before
   * `loading` existed, an empty `items` array during the fetch window (`[]`
   * with `loadError: false`) was indistinguishable from a confirmed-empty
   * list — exactly the case `AssessmentPageClient.tsx`'s module doc claimed
   * could never happen. These three tests are the non-vacuity proof that
   * the third state is real, not just accepted as an argument: each of the
   * three booleans-off-by-one combinations below produces a DIFFERENT
   * message, so no single boolean alone determines the rendered text.
   */
  it('shows a distinct loading message (not confirmed-empty, not could-not-load) while the initial fetch is in flight', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: [], loading: true, loadError: false });
    const text = extractText(tree);
    expect(text).toMatch(/loading evidence/i);
    expect(text).not.toMatch(/no evidence attached/i);
    expect(text).not.toMatch(/could not be loaded/i);
  });

  it('prefers the loading message over the could-not-load message if both were ever true simultaneously -- loading is not yet settled, so it cannot also be a settled failure', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: [], loading: true, loadError: true });
    const text = extractText(tree);
    expect(text).toMatch(/loading evidence/i);
    expect(text).not.toMatch(/could not be loaded/i);
  });
});

/**
 * Fix round 2 (Important, reviewer finding). THE BUG: `loading`/`loadError`/
 * the confirmed-empty message are all gated on `items.length === 0` (tested
 * above) -- correct for THOSE three, since they describe "nothing to show
 * instead of a list". Round 1's reviewer found that gating the NEW
 * `stale` signal the same way made it invisible for exactly the common
 * case: a question that already has evidence. These tests are the
 * non-vacuity proof for THAT specific claim -- every one of them uses
 * BASE_ITEMS (non-empty) deliberately, which the round-1-shaped gate
 * (`items.length === 0 && ...`) would never satisfy. A test built on an
 * EMPTY list would prove nothing here (the existing gate already covers
 * that case) -- this is precisely how the round-2 defect survived review.
 */
describe('EvidenceAttach -- stale-but-saved warning (round 2)', () => {
  it('shows the stale warning even when items is NON-EMPTY -- the exact case the round-2 bug missed', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: BASE_ITEMS, stale: true });
    expect(BASE_ITEMS.length).toBeGreaterThan(0); // guard against the fixture itself regressing to empty
    const text = extractText(tree);
    expect(text).toMatch(/saved/i);
    expect(text).toMatch(/reload/i);
  });

  it('does not show the stale warning when stale is false, even with non-empty items', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: BASE_ITEMS, stale: false });
    const status = findAll(tree, (el) => (el.props as { role?: string }).role === 'status');
    expect(status.length).toBe(0);
  });

  it('renders the stale warning via role="status" (advisory), never role="alert" -- distinct from `error`, which IS an alert: the action succeeded, so this must not read as a failure report', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: BASE_ITEMS, stale: true, error: null });
    const status = findAll(tree, (el) => (el.props as { role?: string }).role === 'status');
    const alert = findAll(tree, (el) => (el.props as { role?: string }).role === 'alert');
    expect(status.length).toBe(1);
    expect(alert.length).toBe(0);
  });

  it('never says the action "failed" when stale (that would be a different, worse lie than showing nothing) -- and still renders the (unrelated) list content underneath', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: BASE_ITEMS, stale: true });
    const text = extractText(tree);
    expect(text).not.toMatch(/fail/i);
    expect(text).toContain(BASE_ITEMS[0].filename); // the stale-but-real list is still shown, not hidden
  });

  it('can show BOTH stale and a genuine mutation error together -- they are independent channels, not mutually exclusive', () => {
    const tree = EvidenceAttach({ ...BASE_PROPS, items: BASE_ITEMS, stale: true, error: 'Could not attach this file.' });
    const text = extractText(tree);
    expect(text).toMatch(/saved/i); // stale
    expect(text).toContain('Could not attach this file.'); // error
  });
});

describe('EvidenceAttach -- callback wiring', () => {
  it('calls onUpload with the selected file when the file input changes', () => {
    const calls: File[] = [];
    const tree = EvidenceAttach({ ...BASE_PROPS, onUpload: (f) => calls.push(f) });
    const input = findAll(tree, (el) => el.type === 'input' && (el.props as { type?: string }).type === 'file')[0];
    expect(input).toBeDefined();
    const fakeFile = { name: 'x.pdf' } as File;
    const fakeEvent = {
      target: { files: [fakeFile], value: 'C:\\fakepath\\x.pdf' },
    } as unknown as React.ChangeEvent<HTMLInputElement>;
    (input!.props as { onChange: (e: unknown) => void }).onChange(fakeEvent);
    expect(calls).toEqual([fakeFile]);
  });

  it('does not call onUpload when the change event carries no file (picker cancelled)', () => {
    const calls: File[] = [];
    const tree = EvidenceAttach({ ...BASE_PROPS, onUpload: (f) => calls.push(f) });
    const input = findAll(tree, (el) => el.type === 'input' && (el.props as { type?: string }).type === 'file')[0];
    const fakeEvent = { target: { files: [], value: '' } } as unknown as React.ChangeEvent<HTMLInputElement>;
    (input!.props as { onChange: (e: unknown) => void }).onChange(fakeEvent);
    expect(calls).toEqual([]);
  });

  it('calls onDelete with the item id when its delete button is clicked', () => {
    const calls: string[] = [];
    const tree = EvidenceAttach({ ...BASE_PROPS, onDelete: (id) => calls.push(id) });
    const btn = findByTypeAndText(tree, 'button', 'Delete evidence');
    (btn!.props as { onClick: () => void }).onClick();
    expect(calls).toEqual(['ev-1']);
  });
});

describe('EvidenceAttach -- download link', () => {
  it('builds the download href from orgSlug and the evidence id, never from the filename', () => {
    const tree = EvidenceAttach({
      ...BASE_PROPS,
      orgSlug: 'org-a',
      items: [{ id: 'ev-xyz', filename: 'ignored name; not part of the URL.pdf', byteSize: 1, uploadedAt: '2026-08-06T00:00:00.000Z' }],
    });
    const link = findByTypeAndText(tree, 'a', 'Download evidence');
    expect((link!.props as { href?: string }).href).toBe('/api/v1/orgs/org-a/evidence/ev-xyz');
  });
});

describe('EvidenceAttach -- D-150 (explaining the format restriction to the user)', () => {
  it('sets accept on the file input to steer the OS picker toward the accepted formats', () => {
    const tree = EvidenceAttach(BASE_PROPS);
    const input = findAll(tree, (el) => el.type === 'input' && (el.props as { type?: string }).type === 'file')[0];
    expect((input!.props as { accept?: string }).accept).toMatch(/pdf/i);
  });

  it('states the accepted formats and size limit in visible copy, using the same MAX_UPLOAD_BYTES the coupling test pins', () => {
    const text = extractText(EvidenceAttach(BASE_PROPS));
    expect(text).toMatch(/PDF/);
    expect(text).toMatch(/PNG/);
    expect(text).toMatch(/JPEG/);
    expect(text).toMatch(/ZIP/);
    expect(text).toContain(formatBytes(MAX_UPLOAD_BYTES));
  });

  /**
   * C6 whole-branch review, F6. Spec §3.2 names the accepted set as "PDF,
   * PNG, JPEG, and the OOXML family (.docx, .xlsx, .pptx)", and the server
   * genuinely accepts all three: `inspect()` matches `PK\x03\x04` and
   * returns `application/zip` (lib/evidence/inspect.ts), and the upload
   * route stores THAT sniffed type -- it never compares against the
   * browser's declared content-type, so a `.docx` round-trips today. The
   * UI said "PDF, PNG, JPEG, ZIP" and its `accept` attribute listed
   * `.zip` only, so the OS file picker greyed out the exact format an
   * institution most likely holds its policies in. This pins both halves
   * together: a future edit that adds a format to one and not the other
   * fails here.
   */
  it('offers the OOXML formats spec §3.2 accepts and the server already stores -- .docx/.xlsx/.pptx, not just .zip', () => {
    const tree = EvidenceAttach(BASE_PROPS);
    const input = findAll(tree, (el) => el.type === 'input' && (el.props as { type?: string }).type === 'file')[0];
    const accept = (input!.props as { accept?: string }).accept ?? '';
    for (const ext of ['.docx', '.xlsx', '.pptx']) {
      expect(accept).toContain(ext);
    }
    const text = extractText(EvidenceAttach(BASE_PROPS));
    expect(text).toMatch(/Word/i);
    expect(text).toMatch(/Excel/i);
    expect(text).toMatch(/PowerPoint/i);
  });
});

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
    const allowed = ['orgSlug', 'projectId', 'initial', 'disabled', 'onChange', 'onUploadState', 'onItemsChange', 'notUploaded', 'fromVersionNumber'];
    expect(Object.keys(props).filter((k) => !allowed.includes(k))).toEqual([]);
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
