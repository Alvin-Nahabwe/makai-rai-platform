import { describe, expect, it } from 'vitest';
import { continueTarget, nextStep } from '@/lib/home/nextStep';
import { openQuestionIds } from '@/lib/data/projects';
import type { ScopeAnswer, Stage, StoredDecisionStatus } from '@/types/record';

/** Plan 1B Task 9 step 1 (rule C2): the next question with no decision after the last-saved one, wrapping round. */
const Q = ['q1', 'q2', 'q3', 'q4', 'q5'].map((id) => ({ id, text: `Text of ${id}` }));
const OPEN = new Set(['q2', 'q4']);

describe('nextStep (C2)', () => {
  it('(a) after q2 the next open question is q4, rule next-open', () => {
    expect(nextStep({ questions: Q, open: OPEN, after: 'q2' })).toEqual({ questionId: 'q4', rule: 'next-open' });
  });
  it('(b) after q4 it wraps round to q2, rule next-open', () => {
    expect(nextStep({ questions: Q, open: OPEN, after: 'q4' })).toEqual({ questionId: 'q2', rule: 'next-open' });
  });
  it('(c) after q1 the next open question is q2', () => {
    expect(nextStep({ questions: Q, open: OPEN, after: 'q1' })).toEqual({ questionId: 'q2', rule: 'next-open' });
  });
  it('(d) with no open question it is the last-saved question itself, rule last-saved', () => {
    expect(nextStep({ questions: Q, open: new Set(), after: 'q3' })).toEqual({ questionId: 'q3', rule: 'last-saved' });
  });
  it('(e) a last-saved question the content dropped gives the first open question, rule next-open', () => {
    expect(nextStep({ questions: Q, open: OPEN, after: 'q-dropped' })).toEqual({ questionId: 'q2', rule: 'next-open' });
  });
  it('(f) a person who never saved gets the first open question, rule first-open', () => {
    expect(nextStep({ questions: Q, open: OPEN, after: null })).toEqual({ questionId: 'q2', rule: 'first-open' });
  });
  it('(g) no open question and a last-saved question not in the list gives null', () => {
    expect(nextStep({ questions: Q, open: new Set(), after: 'q-dropped' })).toBeNull();
  });
  it('an open id that is not in the questions is never chosen', () => {
    expect(nextStep({ questions: Q, open: new Set(['q-other']), after: null })).toBeNull();
    expect(nextStep({ questions: Q, open: new Set(['q-other']), after: 'q3' })).toEqual({ questionId: 'q3', rule: 'last-saved' });
  });
});

/** The rule stageView counts as noDecision, moved out so Home and the stage page use one rule. */
type Row = { status: StoredDecisionStatus | null; scopeAnswer: ScopeAnswer | null };
const GATE = 'gate';
const QUESTIONS = [
  { id: GATE }, { id: 'a' }, { id: 'b' }, { id: 'c', condition: { questionId: GATE } },
];
// The gate excludes `c` when it is answered 'no' (a 'yes' or no answer leaves it in), as the content's condition does.
const applies = (id: string, gate: ScopeAnswer | null) => id !== 'c' || gate !== 'no';
const open = (rows: Record<string, Row>) => openQuestionIds({ questions: QUESTIONS, current: new Map(Object.entries(rows)), applies });

describe('openQuestionIds', () => {
  it('a question with no row is open', () => {
    expect(open({})).toEqual(new Set([GATE, 'a', 'b', 'c']));
  });
  it('a question whose current version is a withdrawal is open', () => {
    expect(open({ a: { status: 'withdrawn', scopeAnswer: null } })).toEqual(new Set([GATE, 'a', 'b', 'c']));
  });
  it('a decided question is not open', () => {
    expect(open({ a: { status: 'done', scopeAnswer: null }, b: { status: 'not_yet', scopeAnswer: null } })).toEqual(new Set([GATE, 'c']));
  });
  it('an answered gate is decided', () => {
    expect(open({ [GATE]: { status: null, scopeAnswer: 'yes' } })).toEqual(new Set(['a', 'b', 'c']));
  });
  it('a question the gate excludes is not open', () => {
    expect(open({ [GATE]: { status: null, scopeAnswer: 'no' } })).toEqual(new Set(['a', 'b']));
  });
  it('a row with neither status nor scope answer is open', () => {
    expect(open({ b: { status: null, scopeAnswer: null } })).toEqual(new Set([GATE, 'a', 'b', 'c']));
  });
});

/** Plan 1C C11 (cut): the project page's primary action delegates to nextStep and has no rule of its own (case at plan line 372). */
type StageIn = { questions: ReadonlyArray<{ id: string; text: string }>; open: ReadonlySet<string> };
const qs = (prefix: string) => ['1', '2', '3', '4'].map((n) => ({ id: `${prefix}${n}`, text: `Text of ${prefix}${n}` }));
const stages = (open: Partial<Record<Stage, string[]>>): Record<Stage, StageIn> => ({
  'pre-processing': { questions: qs('pre'), open: new Set(open['pre-processing'] ?? []) },
  'in-processing': { questions: qs('in'), open: new Set(open['in-processing'] ?? []) },
  'post-processing': { questions: qs('post'), open: new Set(open['post-processing'] ?? []) },
});

describe('continueTarget (C11)', () => {
  it('a save: the next open question after it in the last-saved stage, label continue, exactly what nextStep returns', () => {
    const s = stages({ 'pre-processing': ['pre1'], 'in-processing': ['in1', 'in3'] });
    const got = continueTarget(s, { stage: 'in-processing', questionId: 'in2' });
    expect(got).toEqual({ stage: 'in-processing', questionId: 'in3', label: 'continue' });
    expect(got?.questionId).toBe(nextStep({ ...s['in-processing'], after: 'in2' })?.questionId);
  });
  it('a save: wraps round past the end of the stage, exactly what nextStep returns', () => {
    const s = stages({ 'in-processing': ['in1'] });
    const got = continueTarget(s, { stage: 'in-processing', questionId: 'in3' });
    expect(got).toEqual({ stage: 'in-processing', questionId: 'in1', label: 'continue' });
    expect(got?.questionId).toBe(nextStep({ ...s['in-processing'], after: 'in3' })?.questionId);
  });
  it('a save in a fully decided stage: the last-saved question itself (rule last-saved), exactly what nextStep returns', () => {
    const s = stages({ 'pre-processing': ['pre2'] });
    const got = continueTarget(s, { stage: 'in-processing', questionId: 'in2' });
    expect(got).toEqual({ stage: 'in-processing', questionId: 'in2', label: 'continue' });
    expect(got?.questionId).toBe(nextStep({ ...s['in-processing'], after: 'in2' })?.questionId);
  });
  it('a save whose question no longer applies, nothing open: only then the stage with no question (All questions)', () => {
    const s = stages({ 'pre-processing': ['pre1'] });
    expect(nextStep({ ...s['in-processing'], after: 'in-dropped' })).toBeNull();
    expect(continueTarget(s, { stage: 'in-processing', questionId: 'in-dropped' })).toEqual({ stage: 'in-processing', questionId: null, label: 'continue' });
  });
  it('a last save in In-processing never yields a question of another stage', () => {
    const s = stages({ 'pre-processing': ['pre1', 'pre2'], 'post-processing': ['post1'] });
    for (const after of ['in1', 'in4', 'in-dropped']) {
      const got = continueTarget(s, { stage: 'in-processing', questionId: after });
      expect(got?.stage).toBe('in-processing');
      expect(got?.questionId === null || got?.questionId.startsWith('in')).toBe(true);
    }
  });
  it('no save: the first open question of the first stage that has one, label start, exactly what nextStep returns', () => {
    const s = stages({ 'pre-processing': ['pre3', 'pre4'], 'in-processing': ['in1'] });
    const got = continueTarget(s, null);
    expect(got).toEqual({ stage: 'pre-processing', questionId: 'pre3', label: 'start' });
    expect(got?.questionId).toBe(nextStep({ ...s['pre-processing'], after: null })?.questionId);
  });
  it('no save and Pre-processing fully decided: the first open question of In-processing', () => {
    const s = stages({ 'in-processing': ['in2', 'in4'], 'post-processing': ['post1'] });
    expect(continueTarget(s, null)).toEqual({ stage: 'in-processing', questionId: 'in2', label: 'start' });
  });
  it('no save and nothing open anywhere: null', () => {
    expect(continueTarget(stages({}), null)).toBeNull();
  });
});
