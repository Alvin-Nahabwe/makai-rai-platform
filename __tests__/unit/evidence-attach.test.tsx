import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
import { QuestionBlock } from '@/components/assessment/QuestionBlock';
import type { Question } from '@/types/domain';

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
});

// ---------------------------------------------------------------------------
// QuestionBlock wiring: proves the census entry, the component gate and the
// route action all name the SAME action, per the task's own stated failure
// mode -- "a control that looks gated because it is wrapped in a
// conditional, but whose condition is derived from something a client
// controls, or which renders for a role that should not see it because the
// census entry and the component disagree about which action gates it."
// This half proves QuestionBlock hands EvidenceAttach exactly what it was
// given, with no re-derivation; the report cites the grep proof that the
// literal action strings ('evidence:create'/'evidence:delete') are
// identical across e2e/role-matrix.spec.ts, page.tsx and the two route
// files (not mechanically checkable here -- role-matrix.spec.ts is a
// Playwright spec whose top-level code reads a manifest file that only
// exists during a real e2e run, so importing it from vitest would crash).
// ---------------------------------------------------------------------------

const BASE_QUESTION: Question = {
  id: 'Q-PP-01',
  principle: 'Fairness',
  text: 'Some question text',
  type: 'gate',
  options: ['Yes', 'No'],
};

const BASE_QB_PROPS = {
  q: BASE_QUESTION,
  qIdx: 0,
  responses: {},
  validationErrors: {},
  onResponseChange: () => {},
  onChecklistChange: () => {},
  evidenceItems: BASE_ITEMS,
  evidenceLoading: false,
  evidenceLoadError: false,
  canCreateEvidence: true,
  canDeleteEvidence: true,
  evidenceBusy: false,
  evidenceError: null as string | null,
  orgSlug: 'org-a',
  onEvidenceUpload: () => {},
  onEvidenceDelete: () => {},
};

describe('QuestionBlock -- EvidenceAttach wiring', () => {
  it('renders exactly one EvidenceAttach node, identified by reference', () => {
    const tree = QuestionBlock(BASE_QB_PROPS);
    const nodes = findAll(tree, (el) => el.type === EvidenceAttach);
    expect(nodes.length).toBe(1);
  });

  it('passes questionId, orgSlug, items (by reference), loading, loadError, busy and error straight through with no re-derivation', () => {
    const tree = QuestionBlock({ ...BASE_QB_PROPS, evidenceLoading: true });
    const node = findAll(tree, (el) => el.type === EvidenceAttach)[0];
    const props = node.props as EvidenceAttachProps;
    expect(props.questionId).toBe('Q-PP-01');
    expect(props.orgSlug).toBe('org-a');
    expect(props.items).toBe(BASE_ITEMS); // reference equality: QuestionBlock does not filter or copy
    expect(props.loading).toBe(true);
    expect(props.loadError).toBe(false);
    expect(props.busy).toBe(false);
    expect(props.error).toBeNull();
  });

  it('forwards canCreateEvidence/canDeleteEvidence to canCreate/canDelete regardless of the response-input `disabled` prop -- evidence:create/evidence:delete are gated independently of assessment:respond', () => {
    const tree = QuestionBlock({ ...BASE_QB_PROPS, disabled: true, canCreateEvidence: true, canDeleteEvidence: true });
    const node = findAll(tree, (el) => el.type === EvidenceAttach)[0];
    const props = node.props as EvidenceAttachProps;
    expect(props.canCreate).toBe(true);
    expect(props.canDelete).toBe(true);
  });

  it('renders EvidenceAttach with canCreate/canDelete false when the caller says so, independent of `disabled` being false', () => {
    const tree = QuestionBlock({ ...BASE_QB_PROPS, disabled: false, canCreateEvidence: false, canDeleteEvidence: false });
    const node = findAll(tree, (el) => el.type === EvidenceAttach)[0];
    const props = node.props as EvidenceAttachProps;
    expect(props.canCreate).toBe(false);
    expect(props.canDelete).toBe(false);
  });

  it('wraps onEvidenceUpload with this question\'s id before handing it to EvidenceAttach as onUpload', () => {
    const calls: [string, File][] = [];
    const tree = QuestionBlock({ ...BASE_QB_PROPS, onEvidenceUpload: (qId: string, file: File) => calls.push([qId, file]) });
    const node = findAll(tree, (el) => el.type === EvidenceAttach)[0];
    const props = node.props as EvidenceAttachProps;
    const fakeFile = { name: 'x.pdf' } as File;
    props.onUpload(fakeFile);
    expect(calls).toEqual([['Q-PP-01', fakeFile]]);
  });

  it('wraps onEvidenceDelete with this question\'s id before handing it to EvidenceAttach as onDelete', () => {
    const calls: [string, string][] = [];
    const tree = QuestionBlock({ ...BASE_QB_PROPS, onEvidenceDelete: (qId: string, evidenceId: string) => calls.push([qId, evidenceId]) });
    const node = findAll(tree, (el) => el.type === EvidenceAttach)[0];
    const props = node.props as EvidenceAttachProps;
    props.onDelete('ev-1');
    expect(calls).toEqual([['Q-PP-01', 'ev-1']]);
  });
});
