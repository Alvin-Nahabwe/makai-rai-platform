import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { OrgRole } from '@prisma/client';
import type { Identity } from '@/lib/auth/identity';
import type { ControlGroup } from '@/lib/content/suggestions';
import type { ContentRef } from '@/types/api';
import { resetDb } from '../helpers/db';
import { useFixtureContent } from '../helpers/content';
import { addProject, buildOrg, ctxFor, type OrgFixture } from '../helpers/recordFixture';

/**
 * S-11, S-12 and S-13 rendered from real panel data on the fixture bundle (contract "Content bundle"). SUG's
 * `controlsForQuestion` is mocked in this file only, until SUG merges (contract rule 5); the router is the only part
 * of next/navigation a static render cannot provide.
 */
vi.mock('@/lib/content/suggestions', () => ({ controlsForQuestion: vi.fn(() => ({ first: [], rest: [] })), controlsForArea: vi.fn(() => []) }));
vi.mock('next/navigation', async (original) => ({ ...(await original<typeof import('next/navigation')>()), useRouter: () => ({ refresh() {} }), usePathname: () => '/x' }));

const { controlsForQuestion } = await import('@/lib/content/suggestions');
const { loadQuestionPanel } = await import('@/lib/question/panel');
const { QuestionPanelRegions } = await import('@/app/(authenticated)/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]/page');

let c1: ContentRef;
let fx: OrgFixture;
let project: { id: string };

beforeEach(async () => {
  await resetDb();
  c1 = await useFixtureContent('0.0.1-fixture');
  fx = await buildOrg();
  project = await addProject(fx);
  void c1;
});

const identity = (role: OrgRole): Identity => ({
  userId: fx.members[role].userId, email: fx.members[role].email, name: fx.members[role].name, platformRole: 'assessor', mustChangePassword: false,
});
const panelData = (role: OrgRole, questionId: string) =>
  loadQuestionPanel(ctxFor(fx, role), identity(role), { projectId: project.id, stage: 'pre-processing', questionId });
const group = (id: string): ControlGroup => ({ area: { id } as ControlGroup['area'], controls: [] });

describe('S-12 page', () => {
  it('UX-08 FR-CNT-02 (screen): QuestionContent gets the suggestion count and the suggestions section carries id="suggestions"', async () => {
    vi.mocked(controlsForQuestion).mockReturnValueOnce({ first: [group('G1')], rest: [group('G2'), group('G3')] });
    const h = renderToStaticMarkup(createElement(QuestionPanelRegions, { data: await panelData('assessor', 'Q-PP-01') }));
    expect(h).toContain('Ways teams address this (3)');
    expect(h).toMatch(/<section[^>]*id="suggestions"/);
  });

  it('FR-DEC-06 FR-DEC-10 (screen): a new project\'s S-12 shows No decision yet, an empty form with empty date fields and Save decision', async () => {
    const h = renderToStaticMarkup(createElement(QuestionPanelRegions, { data: await panelData('assessor', 'Q-PP-01') }));
    expect(h).toContain('No decision yet.');
    expect(h).toMatch(/<button[^>]*type="submit"[^>]*>Save decision<\/button>/);
    expect([...h.matchAll(/<input[^>]*inputmode="numeric"[^>]*>/gi)].every((m) => !/value="[^"]+"/.test(m[0]))).toBe(true);
  });
});
