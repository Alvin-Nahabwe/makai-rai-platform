import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sealPreview } from '@/lib/data/reviews';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { markerText } from '../helpers/markers';
import {
  addDecision, addProject, addStageReview, buildOrg, ctxFor,
  type FixtureDecision, type OrgFixture,
} from '../helpers/recordFixture';
import type { Actor } from '@/types/record';

// The fixture bundles hold no practiceSameAs; this lets one test have 0.0.2-fixture's Q-PP-01 list 0.0.1-fixture.
const same = vi.hoisted(() => ({ on: false }));
vi.mock('@/lib/content/loader', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/content/loader')>();
  return {
    ...real,
    loadContent: (semver: Parameters<typeof real.loadContent>[0]) => {
      const c = real.loadContent(semver);
      const q = c.questions.get('Q-PP-01');
      if (!same.on || c.semver !== '0.0.2-fixture' || q === undefined) return c;
      return { ...c, questions: new Map(c.questions).set('Q-PP-01', { ...q, practiceSameAs: ['0.0.1-fixture'] }) };
    },
  };
});

/** FR-CNT-08's S-17 count where a question lists the decision's version in practiceSameAs. Kept apart from reviews-preview.test.ts, a protected file. */

let fx: OrgFixture;
let p: { id: string };
let r: { id: string };
let fv: string;

const actor = (role: 'owner'): Actor => ({ userId: fx.members[role].userId, role });
const preview = () => sealPreview(ctxFor(fx, 'owner'), actor('owner'), r.id);
const dec = (questionId: string, contentVersionId: string): FixtureDecision =>
  ({ stage: 'pre-processing', questionId, contentVersionId, by: 'assessor', declaredDate: '2026-10-20' });

beforeEach(async () => {
  await resetDb();
  fv = (await useFixtureContent('0.0.1-fixture')).contentVersionId;
  fx = await buildOrg({ text: markerText });
  p = await addProject(fx);
  r = await addStageReview(fx, p.id, { stage: 'pre-processing' });
});

describe('sealPreview', () => {
  it('FR-CNT-08: rewordedSinceDecision counts 0 for answers whose question lists their version in practiceSameAs', async () => {
    await addDecision(fx, p.id, dec('Q-PP-01', fv));
    const f2 = (await useFixtureContent('0.0.2-fixture')).contentVersionId;
    same.on = true;
    try {
      expect(f2).not.toBe(fv);
      expect((await preview()).rewordedSinceDecision).toBe(0);
    } finally { same.on = false; }
    expect((await preview()).rewordedSinceDecision).toBe(1);
  });
});
