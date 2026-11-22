import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { testDb } from '../__tests__/helpers/db';
import { buildOrg } from '../__tests__/helpers/recordFixture';
import { failOnDialog } from './helpers/dialogs';
import { fillValid, saveAlert, signInWith, waitForQuestionPage } from './helpers/session';
import { DECISION_FORM_COPY } from '../lib/decision/form/copy';
import { FIELD_COPY } from '../lib/ui/field/copy';
import { DECISION_OUTCOME_COPY } from '../lib/decision/outcome/copy';
import { closeOpenedContexts } from './helpers/contexts';

// Every context a test opened is closed after it (helpers/contexts.ts says why).
test.afterEach(closeOpenedContexts);

/**
 * Review Focus RF-3 (FR-DEC-06, FR-ACC-07, UX-26): a draft typed in one browser survives **Sign out everywhere** pressed in
 * a second browser. The refused save shows M-08 (SRS line 2555), **Sign in again** returns to the same question, and the
 * typed reason is there after sign-in.
 *
 * The account is a fresh fixture organisation's assessor, not the shared fixture seat of e2e/helpers/session.ts:
 * Sign out everywhere raises the account's sessionEpoch (route 36), which ends every saved storage state of that account,
 * so using the shared seat would sign it out of every spec that runs after this one. The sign-in is session.ts's
 * signInWith, with this account's own password.
 */
const Q = 'Q-PP-01';
const TYPED = 'Typed before sign out everywhere';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A context of its own, with its own client address (the sign-in limit keys on it, e2e/fixtures/auth.setup.ts). */
async function contextFor(browser: Browser, clientIp: string): Promise<Page> {
  const baseURL = test.info().project.use.baseURL!;
  const ctx = await browser.newContext({ baseURL, extraHTTPHeaders: { 'x-forwarded-for': clientIp } });
  const page = await ctx.newPage();
  failOnDialog(page);
  return page;
}

test.afterAll(async () => {
  await testDb.$disconnect();
});

test('FR-DEC-06 FR-ACC-07 UX-26: a draft survives sign out everywhere from a second browser and returns after sign-in', async ({ browser }) => {
  test.setTimeout(120_000);
  const fx = await buildOrg({ label: 'rf3' });
  const assessor = fx.members.assessor;

  // Browser A: sign in, make a project over route 23, open S-12 of Q-PP-01 and type the answer.
  const a = await contextFor(browser, '10.47.1.1');
  await a.goto('/login');
  await signInWith(a, assessor.email, assessor.password);
  const created = await a.request.post(`/api/v1/orgs/${fx.org.slug}/projects`, { data: { requestId: randomUUID(), name: 'RF-3 project', aiSystemType: 'classification' } });
  expect(created.status(), await created.text()).toBe(201);
  const { id: projectId } = (await created.json()) as { id: string };
  const questionPath = `/orgs/${fx.org.slug}/projects/${projectId}/stages/pre-processing/questions/${Q}`;
  await a.goto(questionPath);
  await waitForQuestionPage(a);
  // A valid answer, so the browser's own field check (M-11) does not answer before the server can.
  await fillValid(a, { reason: TYPED });

  // Browser B: the same account signs in and presses Sign out everywhere on S-21.
  const b = await contextFor(browser, '10.47.1.2');
  await b.goto('/login');
  await signInWith(b, assessor.email, assessor.password);
  await b.goto('/account');
  await b.getByRole('button', { name: 'Sign out everywhere' }).click();
  await b.waitForURL((url) => url.pathname === '/login');
  expect((await testDb.user.findUniqueOrThrow({ where: { id: assessor.userId } })).sessionEpoch).toBe(1);

  // Back in A: the save is refused with M-08, and the answer is kept.
  await a.getByRole('button', { name: 'Save decision' }).click();
  await expect(saveAlert(a)).toHaveText(DECISION_OUTCOME_COPY.save.signedOut);
  expect(await testDb.decisionVersion.count({ where: { projectId } }), 'nothing was saved').toBe(0);
  await a.getByRole('link', { name: 'Sign in again' }).click();
  await signInWith(a, assessor.email, assessor.password);
  await expect(a).toHaveURL(new RegExp(`^${escape(new URL(a.url()).origin)}${escape(questionPath)}$`));
  await waitForQuestionPage(a);
  await expect(a.getByLabel(`${DECISION_FORM_COPY.fields.reason} ${FIELD_COPY.required}`)).toHaveValue(TYPED);

  await a.context().close();
  await b.context().close();
});
