import { test, expect, request as pwRequest, type APIRequestContext, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import type { OrgRole } from '@prisma/client';
import { createAssessment, setResponse, completeStage } from '../lib/engine/AssessmentEngine.js';
import { can, type Action } from '../lib/authz/policy';
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
 * ROUND 2 — ASSERTS THE PROPERTY, NOT A HAND-WRITTEN LIST (D-092's shape:
 * five successive guards each closed the shapes their author enumerated
 * and left the class open; round 1's tests were guard number six — they
 * enumerated D-127/128/129's specific controls and missed
 * `QuickAssessment`'s submit/inputs, `StageSelector`'s "Start Again", and
 * "Complete {stage}", all live and reachable, none named by round 1).
 * Fixed by splitting every screen's checks into a CONTROL REGISTRY (below)
 * — the single place a control's required permission is declared — used
 * two ways: (1) per-role visibility/enabled assertions, same as round 1,
 * now driven by the registry instead of inline if/else; (2) a
 * COMPLETENESS CENSUS, run once per screen as `owner` (who holds every
 * grant, so an unregistered control is visible to it regardless of intent),
 * that walks every `<button>`/`<a href>` inside `<main>` and fails if any
 * has no matching registry entry. A control added to a screen without a
 * registry entry now fails the census instead of silently shipping
 * ungated — this is what "guard number six" needed and round 1 did not
 * have.
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

    // ONE partial response, deliberately not a full stage: the
    // StageSelector's own "Start Again" button only renders once the
    // engineState has SOME response or a completed stage
    // (components/assessment/StageSelector.tsx's own condition) — a
    // brand-new, all-empty assessment would never show it for ANY role,
    // making its gating untestable. Seeding one answer (not completing
    // the stage) is enough to make the button reachable without also
    // completing the stage this assessment is meant to stay "in progress"
    // for.
    let partialState: EngineState = createAssessment();
    partialState = setResponse(partialState, 'pre-processing', 'Q-PP-01', 2);
    const partialPatchRes = await api.patch(`/api/v1/orgs/${org.slug}/assessments/${inProgress.id}`, {
      data: { engineState: partialState },
    });
    if (!partialPatchRes.ok()) throw new Error(`role-matrix setup: partial-response patch failed ${partialPatchRes.status()}`);

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

// ---------------------------------------------------------------------------
// Control registry — the ONE place a screen's controls and their required
// permission are declared. `mode: 'presence'` controls are entirely absent
// from the DOM when not permitted (round 1's "Reset Assessment" shape);
// `mode: 'input'` controls always render but are `disabled` (round 1's
// response-input shape). `action: null` marks a control every role may use
// (pure navigation/read) — included so the completeness census below does
// not flag it as unclassified.
//
// ADDING A NEW MUTATING CONTROL TO ANY SCREEN THIS SUITE WALKS REQUIRES
// ADDING IT HERE. The completeness census fails the build if it doesn't —
// that is the whole point of this file's round-2 rewrite (see the module
// doc above).
// ---------------------------------------------------------------------------

interface Control {
  name: string;
  action: Action | null;
  mode: 'presence' | 'input';
  locator: (page: Page) => Locator;
}

const DASHBOARD_CONTROLS: Control[] = [
  { name: 'Start New Assessment', action: 'project:create', mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Start New Assessment' }) },
];

const PROJECTS_LIST_CONTROLS: Control[] = [
  { name: 'New Project', action: 'project:create', mode: 'presence', locator: (p) => p.getByRole('link', { name: 'New Project' }) },
];

// `/projects/new` 404s outright for a role without `project:create`
// (app/(authenticated)/orgs/[slug]/projects/new/page.tsx) — a whole-page
// gate, checked separately via the response status, not through this
// list. These are the controls INSIDE the form once it does render.
const PROJECTS_NEW_CONTROLS: Control[] = [
  { name: 'Create Project', action: 'project:create', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Create Project' }) },
  { name: 'Cancel', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Cancel' }) },
  { name: 'Show additional details', action: null, mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Show additional details' }) },
  { name: 'Back to Projects', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: /Back to Projects/ }) },
];

// D-012/D-131: "Quick Check" (mode: 'quick') used to be a second entry
// point here; it was retired and deleted (StartAssessmentButton.tsx no
// longer offers it).
const PROJECT_DETAIL_CONTROLS: Control[] = [
  { name: 'Start Full Assessment', action: 'assessment:create', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Start Full Assessment' }) },
  { name: 'Back to Projects', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: /Back to Projects/ }) },
];

const MEMBERS_CONTROLS: Control[] = [
  { name: 'Invite', action: 'member:invite', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Invite' }) },
];

const REPORT_CONTROLS: Control[] = [
  { name: 'Download PDF', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Download PDF' }) },
  { name: 'Back to Assessment', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: /Back to Assessment/ }) },
  { name: 'Print / Export PDF', action: null, mode: 'presence', locator: (p) => p.getByRole('button', { name: /Print/ }) },
];

// StageSelector — no stage open yet. "View Lifecycle Report" is omitted
// deliberately: it only renders once a stage is COMPLETED
// (`canGenerateReport`), a data condition this fixture's in-progress
// assessment never reaches, so it structurally cannot appear here and
// registering it would be speculative, not verified.
const STAGE_SELECTOR_CONTROLS: Control[] = [
  { name: 'Start Again', action: 'assessment:respond', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Start Again' }) },
];

// A lifecycle-stage module open, NOT the last module of the stage — "Next
// Module" is showing, not "Complete {stage}" (component logic:
// `currentModuleIdx < modules.length - 1`).
const ASSESSMENT_MODULE_CONTROLS: Control[] = [
  { name: 'Reset Assessment', action: 'assessment:respond', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Reset Assessment' }) },
  { name: 'Back to stages', action: null, mode: 'presence', locator: (p) => p.getByRole('button', { name: /Back to stages/ }) },
  { name: 'Next Module', action: null, mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Next Module' }) },
];

// The LAST module of the stage open — "Complete {stage}" replaces "Next
// Module", and "Previous Module" now shows. Census-only registry (see the
// positive-control test below); only reached by roles that can actually
// answer their way there.
const ASSESSMENT_LAST_MODULE_CONTROLS: Control[] = [
  { name: 'Reset Assessment', action: 'assessment:respond', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Reset Assessment' }) },
  { name: 'Back to stages', action: null, mode: 'presence', locator: (p) => p.getByRole('button', { name: /Back to stages/ }) },
  { name: 'Previous Module', action: null, mode: 'presence', locator: (p) => p.getByRole('button', { name: /Previous Module/ }) },
  { name: 'Complete Pre-processing', action: 'assessment:complete', mode: 'presence', locator: (p) => p.getByRole('button', { name: /Complete Pre-processing/ }) },
];

async function assertControl(page: Page, role: OrgRole, control: Control): Promise<void> {
  const allowed = control.action === null || can(role, control.action);
  const locator = control.locator(page);
  if (control.mode === 'presence') {
    if (allowed) await expect.soft(locator, control.name).toBeVisible();
    else await expect.soft(locator, control.name).toHaveCount(0);
  } else {
    if (allowed) await expect.soft(locator, control.name).toBeEnabled();
    else await expect.soft(locator, control.name).toBeDisabled();
  }
}

async function assertScreenControls(page: Page, role: OrgRole, controls: readonly Control[]): Promise<void> {
  for (const control of controls) await assertControl(page, role, control);
}

/**
 * The completeness half of O-13. Scans every `<button>`/`<a href>` inside
 * `<main>` (the Sidebar's own nav — identical on every screen, never
 * mutating — lives outside `<main>`, app/(authenticated)/layout.tsx) and
 * flags any whose accessible text matches none of `knownNames`. Response
 * `<input>`s are out of scope here (they carry no comparable text and are
 * covered by the explicit `mode: 'input'` entries above, checked
 * representatively rather than one-by-one — the same reasoning round 1
 * used for the 78-question assessment).
 *
 * DYNAMIC, DATA-REPEATED CONTENT IS EXCLUDED, NOT UNCOVERED: project
 * cards, recent-activity items, per-assessment links, stage cards and
 * module tabs are all read-only navigation whose COUNT varies with data,
 * not role — every role that reaches project:read/assessment:read sees
 * the same set. Members-table row actions are excluded because they are
 * ALREADY independently role-gated client-side by `can()`
 * (MembersManager.tsx, D-118) — a genuine prior finding, not a new gap
 * this suite is choosing to ignore. The report page's `.section-toggle-
 * btn`/`.evidence-toggle-btn`/`.ctrl-resources__toggle`/`.references-
 * list__toggle` accordions are excluded because they are verified
 * (grepped, not assumed) to call only local `setState` — no `fetch`
 * anywhere in components/report/*.tsx.
 *
 * ONLY VISIBLE ELEMENTS COUNT: `CompletionModal`/`ResetModal` are native
 * `<dialog>`s that exist in the DOM (and would match `querySelectorAll`)
 * even while closed — closed is not rendered, and O-13 is about what is
 * RENDERED. `getClientRects().length > 0` is false for a closed
 * `<dialog>`'s descendants (the UA stylesheet sets `display: none`), so
 * this filters them out the same way it would filter out `display: none`
 * from any other cause — this was found live: the first run of this
 * census flagged "View Report Now"/"Reset Everything" (both modal-only
 * buttons) as unclassified before this filter existed.
 */
async function findUnclassifiedControls(page: Page, knownNames: readonly string[]): Promise<string[]> {
  return page.evaluate((names: readonly string[]) => {
    function isIgnored(el: Element): boolean {
      if (el.closest('.project-card')) return true;
      if (el.closest('.activity-item')) return true;
      if (el.closest('.stage-select-card')) return true;
      if (el.classList.contains('module-tab')) return true;
      if (el.closest('.admin-table')) return true;
      if (el.closest('.section-toggle-btn, .evidence-toggle-btn, .ctrl-resources__toggle, .references-list__toggle')) return true;
      const href = el.getAttribute('href') || '';
      if (/\/assessment\/[^/]+$/.test(href)) return true;
      return false;
    }
    const main = document.querySelector('main');
    if (!main) return [];
    const els = Array.from(main.querySelectorAll('button, a[href]'));
    const unclassified: string[] = [];
    for (const el of els) {
      if (el.getClientRects().length === 0) continue; // not rendered (closed <dialog>, display:none, ...)
      if (isIgnored(el)) continue;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // `.includes`, not `.startsWith`: several buttons/links carry a
      // leading icon glyph ("← Back to Projects") the registry's `name`
      // deliberately omits for readability.
      const matches = names.some((n) => text.includes(n));
      if (!matches) unclassified.push(text);
    }
    return unclassified;
  }, knownNames);
}

async function assertNoUnclassifiedControls(page: Page, screenName: string, controls: readonly Control[]): Promise<void> {
  const unclassified = await findUnclassifiedControls(page, controls.map((c) => c.name));
  expect.soft(
    unclassified,
    `${screenName}: unclassified control(s) — add to the registry in e2e/role-matrix.spec.ts: ${unclassified.join(', ')}`,
  ).toEqual([]);
}

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

        await page.goto(`/orgs/${org.slug}/dashboard`);
        await assertScreenControls(page, role, DASHBOARD_CONTROLS);
        if (role === 'owner') await assertNoUnclassifiedControls(page, 'dashboard', DASHBOARD_CONTROLS);

        await page.goto(`/orgs/${org.slug}/projects`);
        await assertScreenControls(page, role, PROJECTS_LIST_CONTROLS);
        if (role === 'owner') await assertNoUnclassifiedControls(page, 'projects list', PROJECTS_LIST_CONTROLS);

        // Projects/new, reached by DIRECT navigation (not the link above) —
        // "every role walks every screen", not just the ones the UI
        // happens to link to for that role. Whole-page gate: 404 for a
        // role without `project:create`, checked via response status
        // before anything inside the (non-existent) page is asserted.
        const projectsNewRes = await page.goto(`/orgs/${org.slug}/projects/new`);
        if (can(role, 'project:create')) {
          expect.soft(projectsNewRes?.status()).toBe(200);
          await assertScreenControls(page, role, PROJECTS_NEW_CONTROLS);
          if (role === 'owner') await assertNoUnclassifiedControls(page, 'projects/new', PROJECTS_NEW_CONTROLS);
        } else {
          expect.soft(projectsNewRes?.status()).toBe(404);
        }

        await page.goto(`/orgs/${org.slug}/projects/${setup.projectId}`);
        await assertScreenControls(page, role, PROJECT_DETAIL_CONTROLS);
        if (role === 'owner') await assertNoUnclassifiedControls(page, 'project detail', PROJECT_DETAIL_CONTROLS);

        // Members settings: Remove/Make-owner/Leave are exercised by the
        // invitation walk in e2e/two-orgs.spec.ts and are already
        // client-gated by `can()` in MembersManager.tsx (D-118) — excluded
        // from the census (see that function's doc), not untested.
        await page.goto(`/orgs/${org.slug}/settings/members`);
        await assertScreenControls(page, role, MEMBERS_CONTROLS);
        if (role === 'owner') await assertNoUnclassifiedControls(page, 'members settings', MEMBERS_CONTROLS);

        // Report: a READ screen. assessment:read is granted to every role,
        // so this is a positive control — proving the matrix does not
        // over-restrict, not just that it under-restricts.
        const reportRes = await page.goto(
          `/orgs/${org.slug}/assessment/${setup.completedAssessmentId}/report`,
        );
        expect.soft(reportRes?.status()).toBe(200);
        await assertScreenControls(page, role, REPORT_CONTROLS);
        if (role === 'owner') await assertNoUnclassifiedControls(page, 'report', REPORT_CONTROLS);
      });

      test('assessment stage selector and module page: response, restart and complete controls are only usable by roles that may use them', async ({ page }) => {
        const setup = orgSetup[org.slug];
        await page.goto(`/orgs/${org.slug}/assessment/${setup.inProgressAssessmentId}`);

        // StageSelector (no stage open yet) — "Start Again" is reachable
        // because beforeAll seeded one partial response (see that
        // function's doc); a brand-new, all-empty assessment would never
        // show it for ANY role, which would make this check vacuous.
        await expect(page.getByRole('heading', { name: 'AI Lifecycle Assessment' })).toBeVisible();
        await assertScreenControls(page, role, STAGE_SELECTOR_CONTROLS);
        if (role === 'owner') await assertNoUnclassifiedControls(page, 'assessment stage selector', STAGE_SELECTOR_CONTROLS);

        await page.getByRole('button', { name: /Pre-processing/ }).click();
        await expect(page.locator('.question-block').first()).toBeVisible();

        await assertScreenControls(page, role, ASSESSMENT_MODULE_CONTROLS);
        if (role === 'owner') await assertNoUnclassifiedControls(page, 'assessment module (not last)', ASSESSMENT_MODULE_CONTROLS);

        // The response inputs themselves: the first question's first radio
        // option must not be an INTERACTIVE (enabled) control for a role
        // that cannot respond — an unauthorized answer would 403 on the
        // debounced autosave PATCH, invisibly to the user (the exact O-13
        // shape the brief names: a control shown that fails on use).
        // Checked representatively (question 1 of 78), same reasoning as
        // round 1: sufficient to establish the defect exists, not a claim
        // every one of the 78 was independently re-verified.
        const firstOption = page.locator('.question-block').first().locator('input').first();
        await assertControl(page, role, {
          name: 'response input',
          action: 'assessment:respond',
          mode: 'input',
          locator: () => firstOption,
        });

        // "Complete {stage}" only exists in the DOM on the LAST module of
        // the stage, reached only by answering every module before it —
        // itself gated on `assessment:respond`, so a role that cannot
        // respond can never structurally reach this button through normal
        // navigation (the response inputs above are disabled, so
        // `validateCurrentModule()` never passes and "Next Module" never
        // advances). Its NEGATIVE case is therefore not independently
        // walkable for those roles; exercised here as a POSITIVE control
        // for respond+complete roles, which also runs the census for this
        // page state.
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

          await assertScreenControls(page, role, ASSESSMENT_LAST_MODULE_CONTROLS);
          if (role === 'owner') await assertNoUnclassifiedControls(page, 'assessment module (last)', ASSESSMENT_LAST_MODULE_CONTROLS);
        }
      });
    });
  }
}
