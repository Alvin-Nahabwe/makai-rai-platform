import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, request, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureMember, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { FINDINGS_COPY } from '../lib/findings/copy';
import { failOnDialog } from './helpers/dialogs';
import { fillValid, saveAlert, signInWith, waitForQuestionPage } from './helpers/session';

/**
 * Review Focus RF-4 (FR-PRJ-03, FR-MEM-03): a write refused on a page that was already open is refused on the server too,
 * and the page says so in the message the SRS gives. Member B (an admin, the one role that can save, upload, seal and
 * generate, FR-AUTHZ-01) holds four pages open: S-12 with a typed reason, S-15's mitigation form ready to save and to take
 * a file, S-17's seal button, and S-18's preview. Owner A then archives the project (route 21), or lowers B to viewer (route 26), and B presses
 * each control. Each page shows its refusal, and the rows of the five record tables of this organisation are unchanged:
 * the property is the row counts, not only the message (obligation VP-S6).
 *
 * S-18 (DOC-a) is the fourth page: B has pressed Generate before the change, which shows the preview and writes nothing
 * (route 15), and presses **Issue this document** (route 16, the write) after it.
 *
 * The organisation is this file's own: lowering a role and archiving a project would break the shared fixture seats of
 * every spec that runs after this one. The counts are scoped to it, so a spec running in another worker does not move them.
 */
const M12 = 'Not saved: this project is archived. Owners and admins can unarchive it.';
const M09 = 'Not saved: your role in this organisation no longer allows this. Your answer is kept on this device. Ask an owner or admin.';
/**
 * S-17's seal refusals are not M-12 and M-09: REV-b's C4 ruling CR-6 (owner copy, components/review/reviewText.ts:111-112)
 * gives a seal its own sentences, because a seal keeps nothing on the device. The spec checks the words the page shows.
 */
const SEAL_ARCHIVED = 'Not sealed: this project is archived.';
const SEAL_ROLE = 'Not sealed: your role changed. Ask an owner or admin.';
/** S-18's refusal for a lowered role is DOC-a's own sentence (lib/documents/copy.ts:81), not M-09; its archived one is M-12. */
const ISSUE_ROLE = 'Not generated: your role in this organisation no longer allows this. Ask an owner or admin.';
const TYPED = 'Typed before the project changed';
const TABLES = ['decision_versions', 'evidence', 'seals', 'issued_documents', 'mitigation_versions'] as const;

let fx: OrgFixture;
let projectId: string;
let reviewId: string;
let findingId: string;
let ownerApi: APIRequestContext;
const sessions: Partial<Record<'owner' | 'admin', string>> = {};

/** Row counts of the five tables, for this organisation only. */
async function countRows(): Promise<Record<(typeof TABLES)[number], number>> {
  const out = {} as Record<(typeof TABLES)[number], number>;
  for (const t of TABLES) {
    out[t] = Number((await testDb.$queryRawUnsafe<Array<{ n: bigint }>>(`select count(*) n from ${t} where "orgId" = $1`, fx.org.id))[0].n);
  }
  return out;
}

async function signIn(browser: Browser, m: FixtureMember, clientIp: string): Promise<string> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': clientIp } });
  try {
    const page = await context.newPage();
    await page.goto('/login');
    await signInWith(page, m.email, m.password);
    return JSON.stringify(await context.storageState());
  } finally {
    await context.close();
  }
}

type Res = Awaited<ReturnType<APIRequestContext['post']>>;
async function expectOk(res: Res, what: string): Promise<void> {
  expect(res.ok(), `${what}: ${res.status()} ${await res.text()}`).toBe(true);
}
async function ok(res: Res, what: string): Promise<{ id: string }> {
  await expectOk(res, what);
  return (await res.json()) as { id: string };
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  const baseURL = test.info().project.use.baseURL!;
  fx = await buildOrg({ label: 'rf4' });
  sessions.owner = await signIn(browser, fx.members.owner, '10.47.2.1');
  sessions.admin = await signIn(browser, fx.members.admin, '10.47.2.2');
  ownerApi = await request.newContext({ baseURL, storageState: JSON.parse(sessions.owner) });
  const base = `/api/v1/orgs/${fx.org.slug}/projects`;
  projectId = (await ok(await ownerApi.post(base, { data: { requestId: randomUUID(), name: 'RF-4 project', aiSystemType: 'classification' } }), 'route 23')).id;
  // A Partly decision on Q-PP-01 raises a shortfall finding (FR-FND-01).
  await ok(await ownerApi.post(`${base}/${projectId}/decisions`, { data: {
    requestId: randomUUID(), stage: 'pre-processing', questionId: 'Q-PP-01', baseVersionNumber: null, status: 'partly', scopeAnswer: null,
    optionsInPlace: [], reasonCode: null, reason: 'Partly in place', decidedBy: { kind: 'outside_role', role: 'supervisor' },
    declaredDate: '2026-10-12', evidenceIds: [],
  } }), 'route 1');
  findingId = (await testDb.finding.findFirstOrThrow({ where: { orgId: fx.org.id, projectId }, select: { id: true } })).id;
  reviewId = (await ok(await ownerApi.post(`${base}/${projectId}/reviews`, { data: { requestId: randomUUID(), stage: 'pre-processing', preparedFor: null } }), 'route 12')).id;
  await ok(await ownerApi.post(`${base}/${projectId}/reviews/${reviewId}/seals`, { data: { requestId: randomUUID() } }), 'route 13');
});

test.afterAll(async () => {
  await ownerApi?.dispose();
  await testDb.$disconnect();
});

type OpenPages = { context: BrowserContext; s12: Page; s15: Page; s17: Page; s18: Page };

/** S-15's mitigation region (it also holds the accept-risk form, whose date fields share the labels). */
const mitigations = (page: Page) => page.getByRole('region', { name: FINDINGS_COPY.finding.mitigations });

/** B's four pages, opened and filled before A changes anything. */
async function openPages(browser: Browser): Promise<OpenPages> {
  const context = await browser.newContext({ storageState: JSON.parse(sessions.admin!) });
  const page = async () => { const p = await context.newPage(); failOnDialog(p); return p; };
  const root = `/orgs/${fx.org.slug}/projects/${projectId}`;

  const s12 = await page();
  await s12.goto(`${root}/stages/pre-processing/questions/Q-PP-02`);
  await waitForQuestionPage(s12);
  await fillValid(s12, { reason: TYPED });

  const s15 = await page();
  await s15.goto(`${root}/findings/${findingId}`);
  // S-15 also holds the accept-risk form, with its own date fields: everything here is scoped to the mitigation region.
  const mit = mitigations(s15);
  await mit.getByRole('button', { name: FINDINGS_COPY.finding.addMitigation }).click();
  await mit.getByRole('combobox', { name: FINDINGS_COPY.mitigationForm.assignedLabel }).selectOption({ label: fx.members.admin.name });
  await mit.getByLabel('Day', { exact: true }).fill('15'); await mit.getByLabel('Month', { exact: true }).fill('3'); await mit.getByLabel('Year', { exact: true }).fill('2027');
  await mit.getByLabel(FINDINGS_COPY.mitigationForm.what).fill(TYPED);
  await mit.getByRole('radio', { name: 'Done' }).check();
  await mit.getByLabel(FINDINGS_COPY.mitigationForm.noArtefact).check();
  await mit.getByLabel(FINDINGS_COPY.mitigationForm.noArtefactWhy).fill('No artefact for this fixture');

  const s17 = await page();
  await s17.goto(`${root}/reviews/${reviewId}/seal`);
  await expect(s17.getByRole('button', { name: 'Seal as seal 2' })).toBeVisible();

  const s18 = await page();
  await s18.goto(`${root}/reviews/${reviewId}/documents`);
  await s18.getByRole('button', { name: 'Generate document' }).click();
  await expect(s18.getByRole('heading', { name: /^Preview: / })).toBeVisible();
  return { context, s12, s15, s17, s18 };
}

/** B presses the controls: Save decision, the file upload, Save mitigation, Seal, and Issue; each page shows its refusal. */
async function pressAll(p: OpenPages, text: { save: string; mitigation: string; seal: string; issue: string }): Promise<void> {
  await p.s12.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(p.s12)).toHaveText(text.save);

  // The upload starts when the file is chosen.
  const mit = mitigations(p.s15);
  await mit.locator('input[type="file"]').setInputFiles({ name: 'rf4.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%rf4\n%%EOF\n') });
  await expect(mit.getByText(text.save).first()).toBeVisible();
  await mit.getByRole('button', { name: 'Save mitigation' }).click();
  // The failed upload holds the save for a choice (MitigationForm's gate); saving without it is the press that reaches the server.
  await mit.getByRole('button', { name: 'Save without it' }).click();
  // The refused upload keeps its own alert with the same sentence; this is the save's refusal, the form's own paragraph.
  await expect(mit.locator('form > p[role="alert"]')).toHaveText(text.mitigation);

  await p.s17.getByRole('button', { name: 'Seal as seal 2' }).click();
  await expect(p.s17.locator('main').getByRole('alert')).toContainText(text.seal);   // Next's route announcer is a second alert, outside <main>

  await p.s18.getByRole('button', { name: 'Issue this document' }).click();
  await expect(p.s18.locator('main').getByRole('alert').filter({ hasText: text.issue })).toBeVisible();
}

test('FR-PRJ-03 RF-4: archiving refuses Save, upload, Seal and Generate on pages already open, and writes nothing', async ({ browser }) => {
  test.setTimeout(180_000);
  const pages = await openPages(browser);
  const before = await countRows();
  await expectOk(await ownerApi.post(`/api/v1/orgs/${fx.org.slug}/projects/${projectId}/archive`, { data: { requestId: randomUUID() } }), 'route 21');
  await pressAll(pages, { save: M12, mitigation: FINDINGS_COPY.failures.archived, seal: SEAL_ARCHIVED, issue: M12 });
  expect(await countRows()).toEqual(before);
  await expect(pages.s12.getByLabel('Reason (required)')).toHaveValue(TYPED);   // 7.4.1: the typed answer stays
  await pages.context.close();
});

test('FR-MEM-03 RF-4: lowering the role to viewer refuses the same four writes on open pages', async ({ browser }) => {
  test.setTimeout(180_000);
  const archived = await testDb.project.findUniqueOrThrow({ where: { id: projectId }, select: { archivedAt: true } });
  if (archived.archivedAt !== null) {
    await expectOk(await ownerApi.post(`/api/v1/orgs/${fx.org.slug}/projects/${projectId}/unarchive`, { data: { requestId: randomUUID() } }), 'route 22');
  }
  const pages = await openPages(browser);
  const before = await countRows();
  const res = await ownerApi.patch(`/api/v1/orgs/${fx.org.slug}/members/${fx.members.admin.userId}`, { data: { requestId: randomUUID(), role: 'viewer' } });
  expect(res.ok(), `route 26: ${res.status()} ${await res.text()}`).toBe(true);
  await pressAll(pages, { save: M09, mitigation: FINDINGS_COPY.failures.forbidden(FINDINGS_COPY.failures.keptInBrowser), seal: SEAL_ROLE, issue: ISSUE_ROLE });
  expect(await countRows()).toEqual(before);
  await pages.context.close();
});
