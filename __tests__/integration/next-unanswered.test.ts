import { beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { ContentRef } from '@/types/api';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addDecision, addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';
import { loadNextTarget, loadNextUnanswered } from '@/lib/question/nextUnanswered';
import { NotFoundError } from '@/lib/data/tenant';

/**
 * Answer cost, task 5: the question to open after a save, chosen on the server from what the project holds now. The fixture
 * bundle holds the 5.x pre-processing order: Q-PP-01..12, the gate, Q-PP-13 and Q-PP-14 (apply only on a Yes), Q-PP-15..
 */
let c1: ContentRef;
let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  c1 = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
});

const ctx = () => ctxFor(fx, 'assessor');
const decide = (questionId: string, over: Omit<Parameters<typeof addDecision>[2], 'stage' | 'questionId' | 'contentVersionId'> = {}) =>
  addDecision(fx, project.id, { stage: 'pre-processing', questionId, contentVersionId: c1.contentVersionId, ...over });
const next = (after: string) => loadNextUnanswered(ctx(), project.id, 'pre-processing', after);
const ALL_BEFORE_GATE = Array.from({ length: 12 }, (_, i) => `Q-PP-${String(i + 1).padStart(2, '0')}`);

describe('loadNextUnanswered', () => {
  it('after the gate is saved No, the next unanswered from Q-PP-GATE-SENSITIVE is not Q-PP-13 or Q-PP-14', async () => {
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'no' });
    const got = await next('Q-PP-GATE-SENSITIVE');
    expect(got).toBe('Q-PP-15');
    expect(['Q-PP-13', 'Q-PP-14']).not.toContain(got);
  });

  it('after the gate is saved Yes, it is Q-PP-13', async () => {
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'yes' });
    expect(await next('Q-PP-GATE-SENSITIVE')).toBe('Q-PP-13');
  });

  it('a withdrawn answer counts as unanswered', async () => {
    await decide('Q-PP-13', { status: 'done' });
    await decide('Q-PP-13', { status: 'withdrawn', withdrawalCode: 'entered_in_error' });
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'yes' });
    expect(await next('Q-PP-GATE-SENSITIVE')).toBe('Q-PP-13');
  });

  it('skips answered questions and goes round to the start for the earliest one left', async () => {
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'yes' });
    await decide('Q-PP-13');
    expect(await next('Q-PP-GATE-SENSITIVE')).toBe('Q-PP-14');
    await decide('Q-PP-14');
    expect(await next('Q-PP-GATE-SENSITIVE')).toBe('Q-PP-15');
    // Every question from Q-PP-15 on is answered: the round ends at the first one before the gate that is still open.
    for (const id of ['Q-PP-15', 'Q-PP-16', 'Q-PP-17', 'Q-PP-18', 'Q-PP-19', 'Q-PP-20', 'Q-PP-21', 'Q-PP-22', 'Q-PP-23']) await decide(id);
    expect(await next('Q-PP-23')).toBe('Q-PP-01');
  });

  it('is null when every question that applies is answered', async () => {
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'no' });
    for (const id of [...ALL_BEFORE_GATE, 'Q-PP-15', 'Q-PP-16', 'Q-PP-17', 'Q-PP-18', 'Q-PP-19', 'Q-PP-20', 'Q-PP-21', 'Q-PP-22', 'Q-PP-23']) await decide(id);
    expect(await next('Q-PP-23')).toBeNull();
  });

  it('keeps the place of the question just saved when it no longer applies', async () => {
    // Q-PP-14 saved, then the gate answered No: Q-PP-14 does not apply now, yet "after" it still means after the gate's position.
    await decide('Q-PP-14');
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'no' });
    expect(await next('Q-PP-14')).toBe('Q-PP-15');
  });
});

describe('loadNextTarget', () => {
  const href = () => `/orgs/${fx.org.slug}/projects/${project.id}/stages/pre-processing`;
  const target = (after: string | undefined, c = ctx(), id = project.id) => loadNextTarget(c, id, 'pre-processing', after);

  it('redirects to the next question with ?saved=', async () => {
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'no' });
    expect(await target('Q-PP-GATE-SENSITIVE')).toBe(`${href()}/questions/Q-PP-15?saved=Q-PP-GATE-SENSITIVE`);
  });

  it('redirects to the end screen with ?saved= when nothing is left', async () => {
    await decide('Q-PP-GATE-SENSITIVE', { scopeAnswer: 'no' });
    for (const id of [...ALL_BEFORE_GATE, 'Q-PP-15', 'Q-PP-16', 'Q-PP-17', 'Q-PP-18', 'Q-PP-19', 'Q-PP-20', 'Q-PP-21', 'Q-PP-22', 'Q-PP-23']) await decide(id);
    expect(await target('Q-PP-23')).toBe(`${href()}/end?saved=Q-PP-23`);
  });

  it('R4: an after that is missing or not a question of the stage goes to the stage page with no saved', async () => {
    expect(await target(undefined)).toBe(href());
    expect(await target('Q-NOT-THERE')).toBe(href());
    expect(await target('https://evil.example')).toBe(href());
  });

  it('a project the organisation does not hold is not found, for a valid and an invalid after alike', async () => {
    const other = await buildOrg({ label: 'other' });
    const theirs = await addProject(other);
    await expect(target('Q-PP-01', ctx(), theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(target(undefined, ctx(), theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(target('Q-PP-01', ctx(), randomUUID())).rejects.toBeInstanceOf(NotFoundError);
  });

  it('reads only through the organisation: another organisation\'s answers on the same question ids do not move the next question', async () => {
    const other = await buildOrg({ label: 'other2' });
    const theirs = await addProject(other);
    for (const id of ['Q-PP-02', 'Q-PP-03']) await addDecision(other, theirs.id, { stage: 'pre-processing', questionId: id, contentVersionId: c1.contentVersionId });
    // Asked as our organisation about their project: not found, and nothing of theirs shows in our own project's answer.
    await expect(target('Q-PP-01', ctx(), theirs.id)).rejects.toBeInstanceOf(NotFoundError);
    expect(await target('Q-PP-01')).toBe(`${href()}/questions/Q-PP-02?saved=Q-PP-01`);
    await expect(loadNextUnanswered(ctx(), theirs.id, 'pre-processing', 'Q-PP-01')).resolves.toBe('Q-PP-02');
  });
});
