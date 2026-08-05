import { test, expect, request as pwRequest, type APIRequestContext } from '@playwright/test';
import fs from 'node:fs';
import type { OrgRole } from '@prisma/client';
import { createAssessment, setResponse, completeStage } from '../lib/engine/AssessmentEngine.js';
import { can } from '../lib/authz/policy';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import type { EngineState, QuestionBank } from '../types/domain';
import questionBankRaw from '../data/questionBank.json';

/**
 * Task 12 Step 1 — O-13: no mutating control is rendered to a role that may
 * not use it. The 726-cell HTTP matrix (Task 11, __tests__/integration/
 * permission-matrix.test.ts) asserts status codes; it is structurally
 * incapable of seeing what a user is SHOWN. This file walks every one of
 * the fixture's 5 roles, in both orgs, through every screen that has a
 * write-capable control, and asserts the control's VISIBILITY matches
 * `can(role, action)` from lib/authz/policy.ts — the same source of truth
 * the server enforces against.
 *
 * FIXTURE, NOT A SECOND ONE (brief constraint 1): every session below is
 * one of the 20 seats `e2e/fixtures/auth.setup.ts` already logged in and
 * saved as a `storageState`. This file only reads
 * `e2e/fixtures/.auth/manifest.json` (written by that setup project, which
 * `playwright.config.ts` runs before this file via the `dependencies`
 * array) — it performs zero fresh logins.
 *
 * SETUP DATA VIA THE API, NOT THE UI: `beforeAll` below creates one project
 * and two assessments (one left in-progress, one driven to `completed`)
 * per org, using the OWNER seat's own storageState through the real
 * `/api/v1/orgs/**` routes. This is ordinary test-fixture construction
 * (the exact pattern `__tests__/integration/permission-matrix.test.ts`
 * uses for its `OrgResources`), not the thing under test — the thing under
 * test is what each of the 10 role sessions below is SHOWN once that data
 * exists, not how it was seeded. A completed assessment needs only ONE
 * lifecycle stage answered (`lib/engine/AssessmentEngine.js#completeStage`
 * — `no_stages` fires only when zero stages are complete), so this file
 * constructs a `pre-processing`-only completion in Node directly against
 * the exported engine functions, the same functions
 * `app/(authenticated)/orgs/[slug]/assessment/[id]/page.tsx` calls
 * client-side — not a second, hand-rolled implementation of the engine's
 * question-answering logic.
 */

const BASE_URL = 'http://localhost:3000';
const questionBank = questionBankRaw as unknown as QuestionBank;

const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

function seat(orgSlug: string, role: OrgRole, index: 0 | 1 = 0): FixtureManifestUser {
  const found = manifest.users.find(
    (u) => u.orgSlug === orgSlug && u.role === role && u.index === index,
  );
  if (!found) throw new Error(`role-matrix: no fixture seat for ${orgSlug}/${role}/${index}`);
  return found;
}

/**
 * Answers every question in one stage with a fixed, low-signal default —
 * good enough to make the stage COMPLETE (what this suite needs), not to
 * produce a meaningful score (not this suite's concern). Multiple passes
 * resolve the stage's own within-stage `condition` (e.g. the two questions
 * gated on `Q-PP-GATE-SENSITIVE === 'Yes'`); cross-stage conditionals are
 * skipped deliberately — they only unlock from an EARLIER stage's answers,
 * which do not exist for a single-stage completion.
 */
function answerStage(state: EngineState, stageName: string): EngineState {
  const stageDef = questionBank.stages[stageName];
  let next = state;
  for (let pass = 0; pass < 3; pass++) {
    for (const mod of stageDef.modules) {
      for (const q of mod.questions) {
        if (q.crossStageCondition) continue;
        const responses = next.stages[stageName]?.responses ?? {};
        if (responses[q.id] !== undefined) continue;
        if (q.condition) {
          const resp = responses[q.condition.questionId];
          if (q.condition.value !== undefined && resp !== q.condition.value) continue;
          if (
            q.condition.minValue !== undefined &&
            !(typeof resp === 'number' && resp >= q.condition.minValue)
          ) {
            continue;
          }
        }
        let value: number | string | string[];
        if (q.type === 'gate') value = q.options?.includes('Yes') ? 'Yes' : (q.options?.[0] ?? 'Yes');
        else if (q.type === 'checklist') value = q.options?.[0] ? [q.options[0]] : [];
        else value = 2;
        next = setResponse(next, stageName, q.id, value);
      }
    }
  }
  return next;
}

type OrgSetup = {
  projectId: string;
  inProgressAssessmentId: string;
  completedAssessmentId: string;
};

const orgSetup: Record<string, OrgSetup> = {};

test.beforeAll(async () => {
  for (const org of manifest.orgs) {
    const owner = seat(org.slug, 'owner');
    const api: APIRequestContext = await pwRequest.newContext({
      baseURL: BASE_URL,
      storageState: owner.storageStatePath,
    });

    const projRes = await api.post(`/api/v1/orgs/${org.slug}/projects`, {
      data: { name: `Role Matrix Project (${org.slug})`, aiSystemType: 'classification' },
    });
    if (!projRes.ok()) throw new Error(`role-matrix setup: project create failed ${projRes.status()}`);
    const project = await projRes.json();

    const inProgressRes = await api.post(`/api/v1/orgs/${org.slug}/assessments`, {
      data: { projectId: project.id, mode: 'full' },
    });
    if (!inProgressRes.ok()) throw new Error(`role-matrix setup: assessment create failed ${inProgressRes.status()}`);
    const inProgress = await inProgressRes.json();

    const toCompleteRes = await api.post(`/api/v1/orgs/${org.slug}/assessments`, {
      data: { projectId: project.id, mode: 'full' },
    });
    if (!toCompleteRes.ok()) throw new Error(`role-matrix setup: second assessment create failed ${toCompleteRes.status()}`);
    const toComplete = await toCompleteRes.json();

    let state: EngineState = createAssessment();
    state = answerStage(state, 'pre-processing');
    state = completeStage(state, 'pre-processing');

    const patchRes = await api.patch(`/api/v1/orgs/${org.slug}/assessments/${toComplete.id}`, {
      data: { engineState: state },
    });
    if (!patchRes.ok()) throw new Error(`role-matrix setup: engineState patch failed ${patchRes.status()}`);

    const completeRes = await api.post(`/api/v1/orgs/${org.slug}/assessments/${toComplete.id}/complete`);
    if (!completeRes.ok()) throw new Error(`role-matrix setup: complete failed ${completeRes.status()}`);

    await api.dispose();

    orgSetup[org.slug] = {
      projectId: project.id,
      inProgressAssessmentId: inProgress.id,
      completedAssessmentId: toComplete.id,
    };
  }
});

for (const [orgIndex, org] of manifest.orgs.entries()) {
  // STATIC label in the test title, deliberately NOT `org.slug`: the
  // fixture's org slugs are re-randomized on every `buildTwoOrgFixture()`
  // call (__tests__/helpers/fixture.ts), and Playwright's main process
  // lists this file's tests once while EACH WORKER independently
  // re-imports it later, after the `setup` project (a dependency of this
  // project — playwright.config.ts) has already rewritten
  // `manifest.json` with a fresh run id. Embedding the slug in the title
  // made the list-time title differ from the run-time title and every
  // test failed with "Test not found in the worker process" — root-caused
  // by diffing the org-slug substring across two consecutive runs of the
  // identical command, which came back different both times (systematic-
  // debugging, not a guess). The label below is invariant across manifest
  // regenerations; `org.slug` itself is still used, correctly, INSIDE each
  // test body, which only ever runs once per worker after `setup` has
  // already completed.
  const orgLabel = orgIndex === 0 ? 'A' : 'B';
  for (const role of FIXTURE_ROLES) {
    const user = seat(org.slug, role);

    test.describe(`O-13: org ${orgLabel} / ${role}`, () => {
      test.use({ storageState: user.storageStatePath });

      test('dashboard, projects, projects/new, project detail, members and report render only the controls this role may use', async ({ page }) => {
        const setup = orgSetup[org.slug];

        // Every check below uses `expect.soft` deliberately: this test's
        // JOB is to enumerate every mutating control this role is wrongly
        // shown across the whole screen walk. A hard `expect` stops the
        // test at the FIRST violation, silently hiding every later one —
        // discovered live in this suite's first real run, where only the
        // dashboard link ever got reported per role even though the
        // project-detail and projects/new checks (below) also violate for
        // the same roles. Soft assertions still fail the test; they just
        // don't truncate the evidence.

        // Dashboard: "Start New Assessment" is a project:create control
        // (it links to /projects/new).
        await page.goto(`/orgs/${org.slug}/dashboard`);
        const dashboardLink = page.getByRole('link', { name: 'Start New Assessment' });
        if (can(role, 'project:create')) {
          await expect.soft(dashboardLink).toBeVisible();
        } else {
          await expect.soft(dashboardLink).toHaveCount(0);
        }

        // Projects list: "New Project".
        await page.goto(`/orgs/${org.slug}/projects`);
        const newProjectLink = page.getByRole('link', { name: 'New Project' });
        if (can(role, 'project:create')) {
          await expect.soft(newProjectLink).toBeVisible();
        } else {
          await expect.soft(newProjectLink).toHaveCount(0);
        }

        // Projects/new, reached by DIRECT navigation (not the link above) —
        // "every role walks every screen", not just the ones the UI
        // happens to link to for that role.
        await page.goto(`/orgs/${org.slug}/projects/new`);
        const createSubmit = page.locator('button[type="submit"]');
        if (can(role, 'project:create')) {
          await expect.soft(createSubmit).toBeVisible();
        } else {
          await expect.soft(createSubmit).toHaveCount(0);
        }

        // Project detail: the two assessment-start controls
        // (assessment:create).
        await page.goto(`/orgs/${org.slug}/projects/${setup.projectId}`);
        const startFull = page.getByRole('button', { name: 'Start Full Assessment' });
        const startQuick = page.getByRole('button', { name: /Quick Check/ });
        if (can(role, 'assessment:create')) {
          await expect.soft(startFull).toBeVisible();
          await expect.soft(startQuick).toBeVisible();
        } else {
          await expect.soft(startFull).toHaveCount(0);
          await expect.soft(startQuick).toHaveCount(0);
        }

        // Members settings: the "Invite someone" form (member:invite).
        // Remove/Make-owner/Leave are exercised by the invitation walk in
        // e2e/two-orgs.spec.ts and are already client-gated by
        // `can()` in MembersManager.tsx (D-118).
        await page.goto(`/orgs/${org.slug}/settings/members`);
        const inviteHeading = page.getByRole('heading', { name: 'Invite someone' });
        if (can(role, 'member:invite')) {
          await expect.soft(inviteHeading).toBeVisible();
        } else {
          await expect.soft(inviteHeading).toHaveCount(0);
        }

        // Report: a READ screen. assessment:read is granted to every role,
        // so this is a positive control — proving the matrix does not
        // over-restrict, not just that it under-restricts.
        const reportRes = await page.goto(
          `/orgs/${org.slug}/assessment/${setup.completedAssessmentId}/report`,
        );
        expect.soft(reportRes?.status()).toBe(200);
        await expect.soft(page.getByRole('link', { name: 'Download PDF' })).toBeVisible();
      });

      test('assessment page: response controls are only usable by roles that may respond', async ({ page }) => {
        const setup = orgSetup[org.slug];
        await page.goto(`/orgs/${org.slug}/assessment/${setup.inProgressAssessmentId}`);

        await page.getByRole('button', { name: /Pre-processing/ }).click();
        await expect(page.locator('.question-block').first()).toBeVisible();

        // "Reset Assessment" — a respond-adjacent mutating control.
        // `expect.soft` for the same reason as the test above: this test
        // checks TWO independent controls (Reset, and the response inputs
        // themselves) and both should be reported even if the first one
        // already violates.
        const resetBtn = page.getByRole('button', { name: 'Reset Assessment' });
        if (can(role, 'assessment:respond')) {
          await expect.soft(resetBtn).toBeVisible();
        } else {
          await expect.soft(resetBtn).toHaveCount(0);
        }

        // The response inputs themselves: the first question's first radio
        // option must not be an INTERACTIVE (enabled) control for a role
        // that cannot respond — an unauthorized answer would 403 on the
        // debounced autosave PATCH, invisibly to the user (the exact O-13
        // shape the brief names: a control shown that fails on use).
        const firstOption = page.locator('.question-block').first().locator('input').first();
        if (can(role, 'assessment:respond')) {
          await expect.soft(firstOption).toBeEnabled();
        } else {
          await expect.soft(firstOption).toBeDisabled();
        }

        // "Complete {stage}" is only reachable by actually answering the
        // first module — which requires the very capability under test.
        // Exercised here as a POSITIVE control for respond+complete roles
        // only; a role that cannot respond is correctly blocked from ever
        // reaching this button by the assertion above, so re-deriving that
        // block here would be circular, not additional evidence.
        if (can(role, 'assessment:respond') && can(role, 'assessment:complete')) {
          // Click the `<label>`, not `.check()` on the `<input>` — the
          // input is visually hidden behind a custom-styled sibling
          // `<span>` (components/assessment/QuestionBlock.tsx). Loops to a
          // fixed point (re-querying `.question-block` each pass, stopping
          // once a pass finds nothing left to answer) rather than trusting
          // one snapshot — under full-suite (6-worker) load, React can
          // still be incrementally mounting the module's later questions
          // when `.all()` first resolves; see assessment-flow.spec.ts's
          // `answerCurrentModule` doc for the full root-cause, found live
          // debugging this exact class of failure in that file.
          for (let pass = 0; pass < 8; pass++) {
            const blocks = await page.locator('.question-block').all();
            let answeredThisPass = false;
            for (const block of blocks) {
              const input = block.locator('input').first();
              if (await input.isChecked()) continue;
              await block.locator('label').first().click();
              await expect(input).toBeChecked();
              answeredThisPass = true;
            }
            if (!answeredThisPass) break;
          }
          await page.getByRole('button', { name: 'Next Module' }).click();
          await expect(page.getByRole('button', { name: /Complete Pre-processing/ })).toBeVisible({ timeout: 15000 });
        }
      });
    });
  }
}
