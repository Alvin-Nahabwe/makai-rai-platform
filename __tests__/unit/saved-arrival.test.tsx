import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { SavedArrival, savedArrivalFor } from '@/components/question/SavedArrival';
import { SavedArrivalLine } from '@/components/question/SavedArrivalLine';
import { savedArrivalBack, savedArrivalLine } from '@/lib/decision/copy';
import { stageFixture } from '../helpers/stageFixture';
import type { DecisionVersionView } from '@/types/api';

/**
 * The "saved" line a person finds at the top of the next question, or the stage's end screen, after a clean Save (answer cost,
 * design 2026-11-22 section 2 item 3 and 8). vitest runs in the `node` environment with no DOM, so focus on mount is read through
 * a stubbed `react` (refs persist, effects run at once, the ref points at a stub element), as __tests__/unit/ui/dialog.test.tsx does.
 */

type Harness = { refs: Array<{ current: unknown }>; index: number; element: { focus: ReturnType<typeof vi.fn> }; deps: unknown[] };
let harness: Harness | null = null;

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useRef: ((init: unknown) => {
      if (!harness) return actual.useRef(init);
      const h = harness;
      const ref = h.refs[h.index] ?? (h.refs[h.index] = { current: init === null ? h.element : init });
      h.index += 1;
      return ref;
    }) as typeof actual.useRef,
    useEffect: ((effect: () => void | (() => void), deps?: readonly unknown[]) => {
      if (!harness) return actual.useEffect(effect, deps);
      harness.deps = [...(deps ?? [])];
      effect();
      return undefined;
    }) as typeof actual.useEffect,
  };
});

afterEach(() => { harness = null; });

const stage = stageFixture();
const FOURTH = stage.rows[3].questionId;
const BASE = { orgSlug: stage.orgSlug, projectId: stage.projectId, stage: stage.stage, rows: stage.rows };

const version = (over: Partial<DecisionVersionView> = {}): DecisionVersionView => ({
  id: 'dv1', projectId: stage.projectId, stage: stage.stage, questionId: FOURTH, versionNumber: 1, baseVersionNumber: null,
  content: { contentVersionId: 'c1', semver: '0.0.1-fixture', contentHash: 'h' }, status: 'done', scopeAnswer: null,
  optionsInPlace: [], reasonCode: null, reason: null, reasonErased: null,
  decidedBy: { kind: 'member', user: { userId: 'u-me', name: 'Amina N.', formerMember: false } }, declaredDate: '2026-11-22', declaredPrecision: 'day',
  withdrawalCode: null, enteredBy: { userId: 'u-me', name: 'Amina N.', formerMember: false }, enteredByRole: 'assessor',
  receivedAt: '2026-11-22T07:42:00.000Z', evidence: [], ...over,
});
const current = (v: DecisionVersionView): ReadonlyMap<string, DecisionVersionView> => new Map([[v.questionId, v]]);

describe('the "saved" line', () => {
  it('answer cost 6: renders the line with "you" for the viewer\'s own answer and the declared date, and a link back to the question', () => {
    const arrival = savedArrivalFor({ ...BASE, current: current(version()) }, FOURTH)!;
    expect(arrival).not.toBeNull();
    const html = renderToStaticMarkup(<SavedArrival {...arrival} viewerId="u-me" />);
    const text = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
    expect(text).toBe('Your answer to question 4 is saved: decided by you, 22 Nov 2026. Back to question 4');
    expect(html).toContain(`href="/orgs/${stage.orgSlug}/projects/${stage.projectId}/stages/${stage.stage}/questions/${FOURTH}"`);
    // Another member's answer names them, an outside role its label, and the date is written at its own precision.
    const other = renderToStaticMarkup(<SavedArrival {...arrival} viewerId="u-someone-else" />).replace(/<[^>]*>/g, '');
    expect(other).toContain('decided by Amina N., 22 Nov 2026.');
    const year = savedArrivalFor({ ...BASE, current: current(version({ declaredDate: '2026', declaredPrecision: 'year' })) }, FOURTH)!;
    expect(renderToStaticMarkup(<SavedArrival {...year} viewerId="u-me" />).replace(/<[^>]*>/g, '')).toContain('decided by you, 2026.');
  });

  it('answer cost 6: its words are the copy module\'s', () => {
    expect(savedArrivalLine(4, 'you', '22 Nov 2026')).toBe('Your answer to question 4 is saved: decided by you, 22 Nov 2026.');
    expect(savedArrivalBack(4)).toBe('Back to question 4');
  });

  it('answer cost 6: takes focus on mount, and again when the line changes', () => {
    const element = { focus: vi.fn() };
    harness = { refs: [], index: 0, element, deps: [] };
    SavedArrivalLine({ line: 'Your answer to question 4 is saved: decided by you, 22 Nov 2026.', backText: 'Back to question 4', href: '/x' });
    expect(element.focus).toHaveBeenCalledTimes(1);
    // A second arrival on the same route (question 5, then question 6) is the same element: the effect must run for a new line.
    expect(harness.deps).toEqual(['Your answer to question 4 is saved: decided by you, 22 Nov 2026.', '/x']);
    const html = renderToStaticMarkup(<SavedArrivalLine line="Your answer to question 4 is saved: decided by you, 22 Nov 2026." backText="Back to question 4" href="/x" />);
    expect(html).toMatch(/^<p [^>]*tabindex="-1"/);
  });

  it('answer cost 6: the page helper returns null for a saved id not in this stage, not answered, or withdrawn', () => {
    const cur = current(version());
    expect(savedArrivalFor({ ...BASE, current: cur }, FOURTH)).not.toBeNull();
    expect(savedArrivalFor({ ...BASE, current: cur }, undefined)).toBeNull();
    // Text from the address that is not one of this stage's question ids is never printed.
    expect(savedArrivalFor({ ...BASE, current: current(version({ questionId: 'Q-NOT-HERE' })) }, 'Q-NOT-HERE')).toBeNull();
    expect(savedArrivalFor({ ...BASE, current: cur }, '<b>x</b>')).toBeNull();
    expect(savedArrivalFor({ ...BASE, current: cur }, '')).toBeNull();
    // Not answered: no current version for the question.
    expect(savedArrivalFor({ ...BASE, current: new Map() }, FOURTH)).toBeNull();
    expect(savedArrivalFor({ ...BASE, current: cur }, stage.rows[4].questionId)).toBeNull();
    // Withdrawn: the current version is a withdrawal.
    expect(savedArrivalFor({ ...BASE, current: current(version({ status: 'withdrawn', withdrawalCode: 'duplicate' })) }, FOURTH)).toBeNull();
  });

  it('answer cost 6: the question number is the question\'s place in its stage, and a version with no decider or date is not shown', () => {
    expect(savedArrivalFor({ ...BASE, current: current(version()) }, FOURTH)!.questionNumber).toBe(4);
    const first = stage.rows[0].questionId;
    expect(savedArrivalFor({ ...BASE, current: current(version({ questionId: first })) }, first)!.questionNumber).toBe(1);
    expect(savedArrivalFor({ ...BASE, current: current(version({ decidedBy: null })) }, FOURTH)).toBeNull();
    expect(savedArrivalFor({ ...BASE, current: current(version({ declaredDate: null })) }, FOURTH)).toBeNull();
  });
});
