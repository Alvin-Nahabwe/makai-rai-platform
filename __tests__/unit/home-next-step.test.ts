import { describe, expect, it } from 'vitest';
import { nextStep } from '@/lib/home/nextStep';
import { openQuestionIds } from '@/lib/data/projects';
import type { ScopeAnswer, StoredDecisionStatus } from '@/types/record';

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
