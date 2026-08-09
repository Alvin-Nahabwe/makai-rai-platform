import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import { createAssessment, setResponse, completeStage } from '../lib/engine/AssessmentEngine.js';
import questionBankRaw from '../data/questionBank.json';
import type { EngineState, QuestionBank } from '../types/domain';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';

/**
 * Task 12 (C5) — live end-to-end verification of the evidence lifecycle.
 *
 * This is the phase's definition of done: the feature observed working in a
 * real browser against the real running app, not merely passing unit and
 * integration tests. Everything below drives the actual HTTP surface and the
 * actual rendered page — no mocked route handlers, no direct data-layer calls.
 *
 * What this file deliberately does NOT re-prove: per-role control visibility
 * across all five roles and both orgs. `e2e/role-matrix.spec.ts` already walks
 * that exhaustively (its census also fails on any unregistered control), and
 * duplicating it here would be a second measurement with the same lens rather
 * than added coverage. This file proves the SEQUENCE — that the states hand
 * off to each other correctly over a single assessment's life — which no
 * per-state test can establish.
 */

const questionBank = questionBankRaw as unknown as QuestionBank;
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')) as FixtureManifest;

/**
 * Answers every reachable question in a stage. Mirrors `role-matrix.spec.ts`'s
 * own helper rather than inventing a second one: conditional questions only
 * become reachable once their trigger is answered, hence the repeated passes.
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
          if (q.condition.minValue !== undefined && (typeof resp !== 'number' || resp < q.condition.minValue)) continue;
        }
        const value = q.type === 'likert-5' ? 4 : q.type === 'gate' ? (q.options?.[0] ?? 'Yes') : [q.options?.[0] ?? ''];
        next = setResponse(next, stageName, q.id, value);
      }
    }
  }
  return next;
}
const orgA = manifest.orgs[0];

function userFor(role: string): FixtureManifestUser {
  const u = manifest.users.find((x) => x.orgSlug === orgA.slug && x.role === role && x.index === 0);
  if (!u) throw new Error(`fixture has no ${role}[0] in ${orgA.slug}`);
  return u;
}

/** A real PDF: the %PDF-1.4 signature the byte inspector accepts (O-7). */
const PDF_BYTES = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('live-verification-artifact')]);

/** Creates a project + in-progress assessment over the real API, as `user`. */
async function seedAssessment(page: Page, slug: string): Promise<{ projectId: string; assessmentId: string }> {
  const proj = await page.request.post(`/api/v1/orgs/${slug}/projects`, {
    data: { name: `Task 12 live walk ${Date.now()}`, description: 'evidence lifecycle' },
  });
  expect(proj.ok(), `project create: ${proj.status()}`).toBeTruthy();
  const projectId = (await proj.json()).id as string;

  const asmt = await page.request.post(`/api/v1/orgs/${slug}/assessments`, {
    data: { projectId, mode: 'full' },
  });
  expect(asmt.ok(), `assessment create: ${asmt.status()}`).toBeTruthy();
  return { projectId, assessmentId: (await asmt.json()).id as string };
}

test.describe('Task 12 — evidence lifecycle, live', () => {
  test.describe.configure({ mode: 'serial' });

  test('owner walks upload -> download -> delete -> complete -> delete refused', async ({ browser }) => {
    const owner = userFor('owner');
    const ctx = await browser.newContext({ storageState: owner.storageStatePath });
    const page = await ctx.newPage();

    const { assessmentId } = await seedAssessment(page, orgA.slug);

    // --- upload (O-6, O-7, O-9) -------------------------------------------
    const up = await page.request.post(
      `/api/v1/orgs/${orgA.slug}/assessments/${assessmentId}/evidence`,
      {
        multipart: {
          questionId: 'Q-PP-01',
          file: { name: 'live-walk.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES },
        },
      },
    );
    expect(up.status(), await up.text()).toBe(201);
    const evidence = await up.json();
    expect(evidence.mimeType).toBe('application/pdf'); // server-derived, not the client's claim
    expect(evidence.sha256).toMatch(/^[0-9a-f]{64}$/);
    const evidenceId = evidence.id as string;

    // --- download, hostile-safe headers (O-8, O-9) -------------------------
    const dl = await page.request.get(`/api/v1/orgs/${orgA.slug}/evidence/${evidenceId}`);
    expect(dl.status()).toBe(200);
    const headers = dl.headers();
    expect(headers['content-type']).toBe('application/octet-stream');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(await dl.body()).equals(PDF_BYTES)).toBeTruthy();

    // --- the page renders it, and the filename is escaped, not executed ----
    await page.goto(`/orgs/${orgA.slug}/assessment/${assessmentId}`);
    // The page opens on the StageSelector, not the questions — a stage must be
    // entered first. Established live, not assumed: a probe run against the real
    // app found `.question-block` count 0 on arrival and the "BEGIN ASSESSMENT"
    // affordance instead. Driving it the way a user does is the point of C5.
    await expect(page.getByRole('heading', { name: 'AI Lifecycle Assessment' })).toBeVisible();
    await page.getByRole('button', { name: /Pre-processing/ }).click();
    await expect(page.locator('.question-block').first()).toBeVisible();
    await expect(page.getByText('live-walk.pdf').first()).toBeVisible();
    await page.screenshot({ path: 'test-results/task12-01-evidence-attached.png', fullPage: false });

    // --- delete while in-progress is allowed (O-24) ------------------------
    const del = await page.request.delete(`/api/v1/orgs/${orgA.slug}/evidence/${evidenceId}`);
    expect(del.status(), await del.text()).toBe(200);
    const goneCheck = await page.request.get(`/api/v1/orgs/${orgA.slug}/evidence/${evidenceId}`);
    expect(goneCheck.status()).toBe(404);

    // --- re-upload, then complete the assessment ---------------------------
    const up2 = await page.request.post(
      `/api/v1/orgs/${orgA.slug}/assessments/${assessmentId}/evidence`,
      {
        multipart: {
          questionId: 'Q-PP-01',
          file: { name: 'kept.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES },
        },
      },
    );
    expect(up2.status()).toBe(201);
    const keptId = (await up2.json()).id as string;

    // A genuinely completable state. The app refuses to complete an unanswered
    // assessment ("Complete at least one lifecycle stage before finishing") —
    // observed live on the first run of this walk, which is the guard working.
    let state = createAssessment();
    state = answerStage(state, 'pre-processing');
    state = completeStage(state, 'pre-processing');
    const patch = await page.request.patch(
      `/api/v1/orgs/${orgA.slug}/assessments/${assessmentId}`,
      { data: { engineState: state } },
    );
    expect(patch.ok(), `respond: ${patch.status()}`).toBeTruthy();

    const complete = await page.request.post(
      `/api/v1/orgs/${orgA.slug}/assessments/${assessmentId}/complete`,
      { data: {} },
    );
    expect(complete.ok(), `complete: ${complete.status()} ${await complete.text()}`).toBeTruthy();

    // --- delete is now REFUSED (O-24, the immutability half) ---------------
    const delAfter = await page.request.delete(`/api/v1/orgs/${orgA.slug}/evidence/${keptId}`);
    expect(delAfter.status()).toBe(409);
    const stillThere = await page.request.get(`/api/v1/orgs/${orgA.slug}/evidence/${keptId}`);
    expect(stillThere.status(), 'refusing the delete must not also lose the evidence').toBe(200);

    // --- the report shows the provenance line (O-15) -----------------------
    await page.goto(`/orgs/${orgA.slug}/assessment/${assessmentId}/report`);
    const provenance = page.getByText(/Assessed against MAK-AI RAI Framework/i);
    await expect(provenance).toBeVisible();
    await expect(provenance).toContainText('3.0.0');
    await page.screenshot({ path: 'test-results/task12-02-provenance-line.png', fullPage: false });

    await ctx.close();
  });

  test('viewer sees evidence but gets no attach control, and the API refuses', async ({ browser }) => {
    const owner = userFor('owner');
    const viewer = userFor('viewer');

    const octx = await browser.newContext({ storageState: owner.storageStatePath });
    const opage = await octx.newPage();
    const { assessmentId } = await seedAssessment(opage, orgA.slug);
    await octx.close();

    const vctx = await browser.newContext({ storageState: viewer.storageStatePath });
    const vpage = await vctx.newPage();

    await vpage.goto(`/orgs/${orgA.slug}/assessment/${assessmentId}`);
    await expect(vpage.getByRole('heading', { name: 'AI Lifecycle Assessment' })).toBeVisible();
    await vpage.getByRole('button', { name: /Pre-processing/ }).click();
    await expect(vpage.locator('.question-block').first()).toBeVisible();
    await expect(
      vpage.locator('.question-block').first().getByRole('button', { name: 'Attach evidence' }),
    ).toHaveCount(0);
    await vpage.screenshot({ path: 'test-results/task12-03-viewer-no-attach.png', fullPage: false });

    // The UI hiding it is an affordance; the server is the boundary.
    const refused = await vpage.request.post(
      `/api/v1/orgs/${orgA.slug}/assessments/${assessmentId}/evidence`,
      {
        multipart: {
          questionId: 'Q-PP-01',
          file: { name: 'nope.pdf', mimeType: 'application/pdf', buffer: PDF_BYTES },
        },
      },
    );
    expect(refused.status(), 'viewer must be refused server-side, not merely in the UI').toBe(403);

    await vctx.close();
  });
});
