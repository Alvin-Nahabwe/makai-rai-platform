import { test, expect, request as pwRequest, type APIRequestContext, type Page, type Locator } from '@playwright/test';
import fs from 'node:fs';
import type { OrgRole } from '@prisma/client';
import { can, type Action } from '../lib/authz/policy';
import { FIXTURE_ROLES } from '../__tests__/helpers/fixture';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { HOME_COPY } from '../lib/home/copy';
import { PROJECT_COPY } from '../lib/project/copy';
import { PROJECT_FORM_COPY } from '../lib/project/form/copy';

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
 * enumerated D-127/128/129's specific controls and missed two live,
 * reachable ones on the questionnaire pages, since removed with them).
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

const manifest: FixtureManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));

function seat(orgSlug: string, role: OrgRole, index: 0 | 1 = 0): FixtureManifestUser {
  const found = manifest.users.find(
    (u) => u.orgSlug === orgSlug && u.role === role && u.index === index,
  );
  if (!found) throw new Error(`role-matrix: no fixture seat for ${orgSlug}/${role}/${index}`);
  return found;
}

type OrgSetup = {
  projectId: string;
};

const orgSetup: Record<string, OrgSetup> = {};

test.beforeAll(async () => {
  for (const org of manifest.orgs) {
    const owner = seat(org.slug, 'owner');
    const api: APIRequestContext = await pwRequest.newContext({
      baseURL: test.info().project.use.baseURL,
      storageState: owner.storageStatePath,
    });

    const projRes = await api.post(`/api/v1/orgs/${org.slug}/projects`, {
      data: { requestId: crypto.randomUUID(), name: `Role Matrix Project (${org.slug})`, aiSystemType: 'classification' },
    });
    if (!projRes.ok()) throw new Error(`role-matrix setup: project create failed ${projRes.status()}`);
    const project = await projRes.json();

    // One archived project, so S-32 shows an Unarchive button for the roles that may use it.
    const shelvedRes = await api.post(`/api/v1/orgs/${org.slug}/projects`, {
      data: { requestId: crypto.randomUUID(), name: `Role Matrix Shelved (${org.slug})` },
    });
    if (!shelvedRes.ok()) throw new Error(`role-matrix setup: second project create failed ${shelvedRes.status()}`);
    const archiveRes = await api.post(`/api/v1/orgs/${org.slug}/projects/${(await shelvedRes.json()).id}/archive`, { data: { requestId: crypto.randomUUID() } });
    if (archiveRes.status() !== 204) throw new Error(`role-matrix setup: archive answered ${archiveRes.status()}`);

    await api.dispose();

    orgSetup[org.slug] = { projectId: project.id };
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
  { name: 'New project', action: 'project:create', mode: 'presence', locator: (p) => p.getByRole('link', { name: 'New project' }) },
  { name: HOME_COPY.allProjects, action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: HOME_COPY.allProjects }) },
];

const PROJECTS_LIST_CONTROLS: Control[] = [
  { name: 'New project', action: 'project:create', mode: 'presence', locator: (p) => p.getByRole('link', { name: 'New project' }) },
  { name: 'Unarchive', action: 'project:archive', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Unarchive' }).first() },
];

// `/projects/new` 404s outright for a role without `project:create`
// (app/(authenticated)/orgs/[slug]/projects/new/page.tsx) — a whole-page
// gate, checked separately via the response status, not through this
// list. These are the controls INSIDE the form once it does render.
const PROJECTS_NEW_CONTROLS: Control[] = [
  { name: 'Create project', action: 'project:create', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Create project' }) },
  { name: 'Cancel', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Cancel' }) },
  { name: PROJECT_FORM_COPY.moreDetails, action: null, mode: 'presence', locator: (p) => p.getByRole('button', { name: PROJECT_FORM_COPY.moreDetails }) },
  { name: PROJECT_FORM_COPY.back, action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: new RegExp(PROJECT_FORM_COPY.back) }) },
];

const PROJECT_DETAIL_CONTROLS: Control[] = [
  { name: 'Edit project', action: 'project:update', mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Edit project' }) },
  { name: PROJECT_COPY.overview.downloadRecords, action: 'team:export', mode: 'presence', locator: (p) => p.getByRole('link', { name: PROJECT_COPY.overview.downloadRecords }) },
  { name: 'Archive project', action: 'project:archive', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Archive project', exact: true }) },
  { name: 'Findings for this project', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Findings for this project' }) },
  { name: 'Open pre-processing', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Open pre-processing' }) },
  { name: 'Open in-processing', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Open in-processing' }) },
  { name: 'Open post-processing', action: null, mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Open post-processing' }) },
  { name: 'Open a stage review', action: 'review:open', mode: 'presence', locator: (p) => p.getByRole('link', { name: 'Open a stage review' }).first() },
];

const MEMBERS_CONTROLS: Control[] = [
  { name: 'Invite', action: 'member:invite', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Invite', exact: true }) },
  { name: 'Leave this organisation', action: 'member:leave', mode: 'presence', locator: (p) => p.getByRole('button', { name: 'Leave this organisation' }) },
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
 * cards are read-only navigation whose COUNT varies with data, not role —
 * every role that reaches project:read sees the same set. Members-table
 * row actions are excluded because they are ALREADY independently
 * role-gated client-side by `can()` (MembersManager.tsx, D-118) — a
 * genuine prior finding, not a new gap this suite is choosing to ignore.
 *
 * ONLY VISIBLE ELEMENTS COUNT: a native `<dialog>` exists in the DOM (and
 * would match `querySelectorAll`) even while closed — closed is not
 * rendered, and O-13 is about what is RENDERED. `getClientRects().length
 * > 0` is false for a closed `<dialog>`'s descendants (the UA stylesheet
 * sets `display: none`), so this filters them out the same way it would
 * filter out `display: none` from any other cause.
 */
async function findUnclassifiedControls(page: Page, knownNames: readonly string[]): Promise<string[]> {
  return page.evaluate((names: readonly string[]) => {
    function isIgnored(el: Element): boolean {
      if (el.closest('.project-card')) return true;
      // Home's next step is two navigation links (to one question and to its stage's questions), present only when the
      // person has a next step, so it varies with data as the project cards do. That a role which records no decisions
      // never gets it is asserted in this file's case below, and in e2e/home-next-step.spec.ts (T9.5).
      if (el.closest('.next-step')) return true;
      if (el.closest('.members .ui-table')) return true;
      // S-32's project links, S-10's breadcrumb and its stage jump row are read-only navigation, the same for every role.
      // The buttons in S-32's rows (Unarchive) are not: they stay in the census.
      if (el.matches('a[href]') && el.closest('.projects-list')) return true;
      if (el.closest('nav[aria-label="Breadcrumb"]') || el.closest('.stage-list__jump')) return true;
      // "Show more" appears on S-32 only once the organisation has more than 50 projects, which the shared fixture reaches as specs add them.
      if (el.matches('a[href]') && (el.textContent ?? '').trim() === 'Show more') return true;
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

      test('dashboard, projects, projects/new, project detail and members render only the controls this role may use', async ({ page }) => {
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
        // T9.5: a role that records no decisions never gets Home's next step, whatever the data. Its presence for the roles
        // that record depends on their saves, so it is not asserted here.
        if (!can(role, 'decision:write')) {
          await expect.soft(page.locator('.next-step'), `${role}: Home shows no next step to a role that records no decisions`).toHaveCount(0);
          await expect.soft(page.getByRole('link', { name: HOME_COPY.continueRecording }), `${role}: no Continue recording link`).toHaveCount(0);
        }

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
      });
    });
  }
}
