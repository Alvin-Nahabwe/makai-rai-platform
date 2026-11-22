import { describe, expect, it } from 'vitest';
import { nextTarget, pickNextUnanswered } from '@/lib/question/nextUnanswered';

describe('pickNextUnanswered: the next question to answer after a save (answer cost, design 2 item 3)', () => {
  it('is the next one after, going round to the start, skipping answered ones, and null when all are answered', () => {
    expect(pickNextUnanswered(['a', 'b', 'c', 'd'], new Set(['b']), 'a')).toBe('c');
    expect(pickNextUnanswered(['a', 'b', 'c', 'd'], new Set(['a', 'b', 'd']), 'd')).toBe('c');
    expect(pickNextUnanswered(['a', 'b'], new Set(['a', 'b']), 'a')).toBeNull();
  });

  it('skips the question just saved even when it is not in the answered set, and is null when it is the only one left', () => {
    expect(pickNextUnanswered(['a', 'b', 'c'], new Set(['b', 'c']), 'a')).toBeNull();
    expect(pickNextUnanswered(['a', 'b', 'c'], new Set(), 'b')).toBe('c');
  });

  it('is null for an empty list', () => {
    expect(pickNextUnanswered([], new Set(), 'a')).toBeNull();
  });
});

describe('nextTarget: where the next page redirects to (owner ruling R4)', () => {
  const at = { orgSlug: 'acme', projectId: 'p1', stage: 'pre-processing' as const };
  const stageHref = '/orgs/acme/projects/p1/stages/pre-processing';
  const ids = ['Q-1', 'Q-2', 'Q-3'];

  it('goes to the next question with ?saved= the question just saved', () => {
    expect(nextTarget(at, ids, 'Q-1', 'Q-2')).toBe(`${stageHref}/questions/Q-2?saved=Q-1`);
  });

  it('goes to the stage end screen with ?saved= when nothing is left', () => {
    expect(nextTarget(at, ids, 'Q-3', null)).toBe(`${stageHref}/end?saved=Q-3`);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a question of the stage', 'Q-OTHER'],
    ['an address', 'https://evil.example/x'],
    ['a path trick', '../../x'],
    ['a query trick', 'Q-1&next=//evil.example'],
  ])('goes to the stage page with no saved when after is %s, and ignores any next', (_n, after) => {
    expect(nextTarget(at, ids, after, 'Q-2')).toBe(stageHref);
    expect(nextTarget(at, ids, after, null)).toBe(stageHref);
  });
});
