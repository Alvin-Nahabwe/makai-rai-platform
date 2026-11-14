import 'dotenv/config';
import { createHash, randomBytes } from 'node:crypto';
import { test, expect, type Browser, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { currentLegalText } from '../lib/legal/registry';
import { ACCEPT_LABEL } from '../components/legal/AcceptancesForm';
import { INVITATION_COPY } from '../lib/invitations/copy';
import { ACCEPTANCES_COPY } from '../lib/legal/acceptances/copy';
import { ACCEPTED_KINDS, CONSENT_TYPE_FOR } from '../types/legal';
import { draftKeys, draftValues, fillValid, stageOf, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';

/**
 * Version 2 of the three accepted texts reaches an account that accepted version 1 (FR-ACC-04, FR-ACC-03 threat A5,
 * FR-ACC-02). Each account is made per test with buildOrg; 'version-1' gives it the rows a person who signed up
 * under the first texts holds. Each context signs in from its own client address, as acceptances.spec.ts does.
 */

let ipSeq = 0;
const nextClientIp = () => `10.46.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

async function newPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } });
  return context.newPage();
}

async function signIn(page: Page, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<void> {
  await page.goto('/login');
  await page.waitForLoadState('networkidle');
  await expect(async () => {
    await page.fill('#email', account.email);
    await page.fill('#password', account.password);
    await page.waitForTimeout(300);
    await expect(page.locator('#email')).toHaveValue(account.email, { timeout: 100 });
    await expect(page.locator('#password')).toHaveValue(account.password, { timeout: 100 });
  }).toPass({ timeout: 20_000 });
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
}

async function invitationFor(fx: OrgFixture, email: string) {
  const raw = randomBytes(32).toString('hex');
  await testDb.invitation.create({ data: {
    orgId: fx.org.id, email, role: 'viewer', tokenHash: createHash('sha256').update(raw).digest('hex'),
    invitedById: fx.members.owner.userId, expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  } });
  return raw;
}

const userCount = (email: string) => testDb.user.count({ where: { email } });
const countingRows = (userId: string) => testDb.consentRecord.count({ where: {
  userId, granted: true, voidedAt: null,
  OR: ACCEPTED_KINDS.map((k) => ({ consentType: CONSENT_TYPE_FOR[k], version: currentLegalText(k).version, textHash: currentLegalText(k).sha256 })),
} });

test.afterAll(async () => {
  await testDb.$disconnect();
});

test.describe('version 2 of the terms, the privacy notice and the consent to storage abroad', () => {
  test('FR-ACC-04: an account holding version-1 rows of the three kinds is sent to /acceptances, sees the three version-2 texts, accepts, and reaches home', async ({ browser }) => {
    const fx = await buildOrg({ label: 'vtwo', acceptances: 'version-1' });
    const user = fx.members.assessor;
    const page = await newPage(browser);
    await signIn(page, user);
    await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    await expect(page).toHaveURL(/\/acceptances$/);
    await page.goto('/');
    await expect(page).toHaveURL(/\/acceptances$/);

    // Each box is for the version now current, and its link opens that version's page.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ACCEPTANCES_COPY.legend);
    await expect(page.getByRole('checkbox')).toHaveCount(3);
    for (const kind of ACCEPTED_KINDS) {
      const { version, publishedOn } = currentLegalText(kind);
      expect(version, `${kind}: a text later than version 1 is current`).not.toBe('1');
      await expect(page.locator(`#accept-${kind}-hint`)).toContainText(`Version ${version}, published`);
      expect(publishedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      await expect(page.locator(`#accept-${kind}-hint a`)).toHaveAttribute('href', `/legal/${kind}/${version}`);
      await expect(page.getByLabel(ACCEPT_LABEL[kind], { exact: true })).not.toBeChecked();
    }
    // The version-1 rows alone do not open the app: nothing was recorded for the new texts.
    expect(await countingRows(user.userId)).toBe(0);

    for (const kind of ACCEPTED_KINDS) await page.getByLabel(ACCEPT_LABEL[kind], { exact: true }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    await page.waitForURL((url) => url.pathname !== '/acceptances');
    expect(await countingRows(user.userId)).toBe(3);
    // The version-1 rows are kept, not replaced: consent records are append-only.
    expect(await testDb.consentRecord.count({ where: { userId: user.userId } })).toBe(6);
    const res = await page.goto(`/orgs/${fx.org.slug}/dashboard`);
    expect(res?.status()).toBe(200);
    await expect(page).toHaveURL(new RegExp(`/orgs/${fx.org.slug}/dashboard$`));
    await page.context().close();
  });

  test('with unsaved reason text, the save is refused for acceptances, and after accepting the text is restored on the question page', async ({ browser }) => {
    const Q = 'Q-PP-01';
    const REASON = 'Typed before the new texts were published';
    // `late` holds version-1 rows only: what an account that signed up under the first texts is when version 2 is current.
    // `early` is a colleague of the same organisation who holds the current texts, so the question page opens for it and writes
    // the draft through the real form; the draft is then placed under `late`'s own key (the key names the account and
    // nothing else of the draft does), because consent rows are append-only and an account cannot be made to lose them mid-test.
    const fx = await buildOrg({ label: 'vtwodraft' });
    const late = (await buildOrg({ label: 'vtwolate', acceptances: 'version-1' })).members.owner;
    const early = fx.members.assessor;
    const lateMember = await testDb.membership.create({ data: { orgId: fx.org.id, userId: late.userId, role: 'assessor' } });
    expect(lateMember.orgId).toBe(fx.org.id);

    const writer = await newPage(browser);
    await signIn(writer, early);
    const created = await writer.request.post(`/api/v1/orgs/${fx.org.slug}/projects`, { data: { requestId: crypto.randomUUID(), name: `Reacceptance ${Date.now()}`, aiSystemType: 'classification' } });
    expect(created.status(), 'project create').toBe(201);
    const { id } = (await created.json()) as { id: string };
    const question = `/orgs/${fx.org.slug}/projects/${id}/stages/${stageOf(Q)}/questions/${Q}`;
    await writer.goto(question);
    await waitForQuestionPage(writer);
    await fillValid(writer, { reason: REASON });
    const [key] = await draftKeys(writer, early.userId);
    const [stored] = await draftValues(writer);
    expect(key, 'the form kept the answer on the device').toBeTruthy();
    await writer.context().close();

    const page = await newPage(browser);
    await signIn(page, late);
    await page.evaluate(([k, v]) => localStorage.setItem(k, v), [key.replace(early.userId, late.userId), stored] as const);

    // The question page does not open: the gate sends the account to S-05.
    await page.goto(question);
    await expect(page).toHaveURL(/\/acceptances$/);
    // The way back is the one the form itself takes after a refused save (lib/question/saveOutcome.ts navigationForOutcome).
    await page.goto(`/acceptances?callbackUrl=${encodeURIComponent(question)}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(ACCEPTANCES_COPY.legend);

    // The save itself is refused by the server, whatever the page does: 403 acceptances_required, nothing written.
    const refused = await page.request.post(`/api/v1/orgs/${fx.org.slug}/projects/${id}/decisions`, { data: {
      requestId: crypto.randomUUID(), stage: stageOf(Q), questionId: Q, baseVersionNumber: null, status: 'done', scopeAnswer: null,
      optionsInPlace: [], reasonCode: null, reason: REASON, decidedBy: { kind: 'outside_role', role: 'supervisor' }, declaredDate: '2026-10-12', evidenceIds: [],
    } });
    expect(refused.status()).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe('acceptances_required');
    expect(await testDb.decisionVersion.count({ where: { projectId: id } }), 'nothing was written').toBe(0);
    expect(await draftKeys(page, late.userId), 'the unsaved answer is still on this device').toHaveLength(1);

    for (const kind of ACCEPTED_KINDS) await page.getByLabel(ACCEPT_LABEL[kind], { exact: true }).check();
    await page.getByRole('button', { name: 'Accept and continue' }).click();
    // S-05 sends the account home (RecordAcceptances.tsx:38) and does not read callbackUrl; the person opens the question again.
    await page.waitForURL((url) => url.pathname !== '/acceptances');
    await page.goto(question);
    await waitForQuestionPage(page);
    await expect(page.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue(REASON);
    await page.context().close();
  });

  test('an invitation page that posts version-1 acceptances after version 2 exists is refused, shows version 2\'s details, and creates no account', async ({ browser, baseURL }) => {
    const fx = await buildOrg({ label: 'vtwoinv' });
    const email = `vtwo-${Date.now()}@fixture.test`;
    const raw = await invitationFor(fx, email);
    const versionOne = ACCEPTED_KINDS.map((kind) => ({ kind, version: '1' }));

    // Route 31 by hand: the three version-1 pairs, as a page rendered before publication would post them.
    const direct = await (await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } })).request.post(
      `${baseURL}/api/v1/invitations/${raw}/register`, { data: { name: 'Stale Page', password: 'Stale-page-ok-1', acceptances: versionOne } });
    expect(direct.status()).toBe(409);
    const body = (await direct.json()) as { code: string; error: string; missing: string[] };
    expect(body.code).toBe('legal_text_changed');
    expect(body.missing).toEqual([...ACCEPTED_KINDS]);
    expect(await userCount(email)).toBe(0);

    // The same through the page: it posts version-1 pairs, the server answers 409, the alert shows, the form shows version 2's
    // details, and no account is created. This page was rendered at version 2, so the boxes it ticked stay ticked; the reset
    // on a real version change is the form's key, pinned by the textsKey cases in __tests__/unit/acceptances-form.test.tsx.
    const page = await newPage(browser);
    await page.route('**/api/v1/invitations/*/register', async (route) => {
      const sent = JSON.parse(route.request().postData() ?? '{}') as Record<string, unknown>;
      await route.continue({ postData: JSON.stringify({ ...sent, acceptances: versionOne }) });
    });
    await page.goto(`/invitations/${raw}`);
    await page.getByLabel(INVITATION_COPY.name).fill('Stale Page');
    await page.locator('#new-password').fill('Stale-page-ok-1');
    await page.getByRole('button', { name: INVITATION_COPY.continue }).click();
    for (const box of await page.getByRole('checkbox').all()) await box.check();
    await page.getByRole('button', { name: INVITATION_COPY.createAccount }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'A new version of the' }).first()).toBeVisible();
    for (const kind of ACCEPTED_KINDS) {
      await expect(page.locator(`#accept-${kind}-hint`)).toContainText(`Version ${currentLegalText(kind).version}, published`);
    }
    expect(await userCount(email)).toBe(0);
    await page.context().close();
  });

  test('the consent box\'s label is ACCEPT_LABEL[\'cross-border-consent\'] and names the countries the consent text names', async ({ browser }) => {
    const fx = await buildOrg({ label: 'vtwolabel', acceptances: 'version-1' });
    const page = await newPage(browser);
    await signIn(page, fx.members.viewer);
    await expect(page).toHaveURL(/\/acceptances$/);
    const box = page.getByLabel(ACCEPT_LABEL['cross-border-consent'], { exact: true });
    await expect(box).toHaveCount(1);
    await expect(box).not.toBeChecked();
    const label = await page.locator('label[for="accept-cross-border-consent"]').innerText();
    const consent = currentLegalText('cross-border-consent').text;
    for (const place of ['Finland', 'around the world', 'the United States']) {
      expect(label, `the label names ${place}`).toContain(place);
      expect(consent, `the consent text names ${place}`).toContain(place);
    }
    await page.context().close();
  });
});
