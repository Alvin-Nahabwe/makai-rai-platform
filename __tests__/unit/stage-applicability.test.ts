import { describe, expect, it } from 'vitest';
import { controlSuggestionsOn } from '@/lib/content/suggestions';
import { nextStageThatApplies, stagesThatApply } from '@/lib/project/applicability';
import { STAGES } from '@/types/record';
import { contentWith, OWNER_TABLE } from '../helpers/contentWith';

/** Stage applicability (G7, dormant until content carries the table) and the control switch (G6). */
const active = contentWith({ stageApplicability: OWNER_TABLE });

describe('stage applicability', () => {
  it('G7 active: the owner table', () => {
    expect([...stagesThatApply(active, 'concept')]).toEqual(['pre-processing']);
    expect([...stagesThatApply(active, 'development')]).toEqual(['pre-processing', 'in-processing']);
    for (const d of ['testing', 'deployed', 'retired']) expect([...stagesThatApply(active, d)]).toEqual([...STAGES]);
  });
  it('G7 dormant: content with no table applies every stage, whatever the development stage (owner: "With 5.2.0")', () => {
    for (const d of [null, 'concept', 'development']) expect([...stagesThatApply({ stageApplicability: null }, d)]).toEqual([...STAGES]);
  });
  it('G7: a blank development stage applies every stage', () => expect([...stagesThatApply(active, null)]).toEqual([...STAGES]));
  it('G7: an unknown development stage throws', () => expect(() => stagesThatApply(active, 'beta')).toThrow(/development stage/));
  it('G3: next stage that applies skips stages that do not', () =>
    expect(nextStageThatApplies(new Set(['pre-processing', 'post-processing']), 'pre-processing')).toBe('post-processing'));
  it('G3: no later stage applies gives null', () =>
    expect(nextStageThatApplies(new Set(['pre-processing']), 'pre-processing')).toBeNull());
  it('controls are off unless the content says its mapping is approved', () => {
    expect(controlSuggestionsOn({ controlSuggestionsApproved: false })).toBe(false);
    expect(controlSuggestionsOn(contentWith({ controlSuggestionsApproved: true }))).toBe(true);
  });
});
