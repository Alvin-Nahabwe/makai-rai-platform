import 'dotenv/config';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { addFinding, addMitigationVersion, addProject, buildOrg, type FixtureAccount, type OrgFixture } from '../__tests__/helpers/recordFixture';
import { expectNoSeriousA11yViolations } from './helpers/a11y';
import { expectFocusVisibleAndUncovered } from './helpers/focus';
import { eatDate } from '../lib/followup/overdue';
import { PROJECT_COPY } from '../lib/project/copy';

/**
 * The follow-up lines of S-10 and the reminder setting of S-21 in a browser (FR-FUP-01, FR-FUP-06,
 * NFR-A11Y-02, NFR-A11Y-05). The screens belong to PRJ (S-10) and ACC-b (S-21): FUP delivers their slot
 * components. A case skips only while its slot is not wired: S-10 while no file under app/ or components/
 * (outside components/followup/) imports StageFollowUp, S-21 while none imports ReminderEmailsSetting. Never on
 * what the page shows, so once the page lands a broken slot fails the case; and under RELEASE_CANDIDATE=1 an
 * unwired slot fails the case instead of skipping it. Accounts are made per case with K0a's buildOrg, as e2e/acceptances.spec.ts does.
 */

let ipSeq = 0;
const nextClientIp = () => `10.77.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;
const DAY_MS = 24 * 3600 * 1000;

async function signedIn(browser: import('@playwright/test').Browser, account: Pick<FixtureAccount, 'email' | 'password'>): Promise<Page> {
  const page = await (await browser.newContext({ extraHTTPHeaders: { 'x-forwarded-for': nextClientIp() } })).newPage();
  await page.goto('/login');
  await page.fill('#email', account.email);
  await page.fill('#password', account.password);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL((url) => url.pathname !== '/login');
  return page;
}

/** An organisation whose project holds one overdue and one later mitigation, both owned by the assessor. */
async function projectWithFollowUp(): Promise<{ fx: OrgFixture; url: string }> {
  const fx = await buildOrg({ label: 'fup' });
  const p = await addProject(fx);
  const f = await addFinding(fx, p.id, { stage: 'pre-processing', source: 'team' });
  const day = (offset: number) => eatDate(new Date(Date.now() + offset * DAY_MS));
  await addMitigationVersion(fx, f.id, { status: 'planned', owner: 'assessor', dueDate: day(-3) });
  await addMitigationVersion(fx, f.id, { status: 'in_progress', owner: 'assessor', dueDate: day(10) });
  return { fx, url: `/orgs/${fx.org.slug}/projects/${p.id}` };
}

/** Tab until the focused control is named `name` (an `aria-label`, its `<label>`, or its text); `inside` limits it to a container. */
async function tabUntil(page: Page, name: RegExp, opts: { inside?: string; max?: number } = {}): Promise<void> {
  const max = opts.max ?? 80;
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press('Tab');
    const found = await page.evaluate(({ inside }) => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return null;
      if (inside && !el.closest(inside)) return null;
      const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
      return (el.getAttribute('aria-label') ?? labelled ?? el.textContent ?? '').trim();
    }, { inside: opts.inside });
    if (found !== null && name.test(found)) return;
  }
  throw new Error(`tabUntil: no focus stop matched ${name} in ${max} presses`);
}

/** S-10's overdue mitigation plates (Route R5: one kit plate per mitigation, its text a link to its finding). */
const FOLLOW_UP = '.stage-line__plate--overdue';

/** True when a source file under `roots`, outside `components/followup/`, imports `components/followup/<component>`. */
export function slotImported(roots: readonly string[], component: string): boolean {
  const imports = [`followup/${component}'`, `followup/${component}"`];
  const walk = (dir: string): boolean => fs.readdirSync(dir, { withFileTypes: true }).some((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || full.split(path.sep).slice(-2).join('/') === 'components/followup' ? false : walk(full);
    return /\.(ts|tsx)$/.test(entry.name) && imports.some((i) => fs.readFileSync(full, 'utf8').includes(i));
  });
  return roots.some((root) => fs.existsSync(root) && walk(root));
}

/** What a case does about its slot: run it, skip it, or fail it (a release candidate may not skip). */
export function gateFor(wired: boolean, releaseCandidate: boolean): 'run' | 'skip' | 'fail' {
  return wired ? 'run' : releaseCandidate ? 'fail' : 'skip';
}

function requireWired(component: string, who: string): void {
  const gate = gateFor(slotImported(['app', 'components'], component), process.env.RELEASE_CANDIDATE === '1');
  if (gate === 'fail') throw new Error(`${who}: nothing outside components/followup/ imports ${component}, and RELEASE_CANDIDATE=1 does not allow a skip`);
  test.skip(gate === 'skip', `nothing imports ${component} yet (${who})`);
}

async function openProject(page: Page, projectPath: string): Promise<void> {
  requireWired('StageFollowUp', 'PRJ, S-10');
  await page.goto(projectPath);
}

test('FR-FUP-01 (helper): the gate finds an importer under app/ or components/, ignores components/followup/ and a longer name, and fails a release candidate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fup-gate-'));
  try {
    const put = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
    const roots = [path.join(dir, 'app'), path.join(dir, 'components')];
    put('app/p/page.tsx', "import { ProjectOverview } from '@/components/project/ProjectOverview';");
    put('components/followup/StageFollowUpCounts.tsx', "import x from '@/components/followup/StageFollowUp';");
    put('components/project/Counts.tsx', "import { StageFollowUpCounts } from '@/components/followup/StageFollowUpCounts';");
    expect(slotImported(roots, 'StageFollowUp')).toBe(false);
    put('components/project/StageColumn.tsx', "import { StageFollowUp } from '@/components/followup/StageFollowUp';");
    expect(slotImported(roots, 'StageFollowUp')).toBe(true);                                       // wired two levels below the page
    expect(slotImported([path.join(dir, 'nowhere')], 'StageFollowUp')).toBe(false);
    expect(gateFor(true, true)).toBe('run');
    expect(gateFor(false, false)).toBe('skip');
    expect(gateFor(false, true)).toBe('fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('NFR-A11Y-02 FR-FUP-01: keyboard only, a member reaches an overdue mitigation from S-10 and opens S-15', async ({ browser }) => {
  const { fx, url } = await projectWithFollowUp();
  const page = await signedIn(browser, fx.members.owner);
  await openProject(page, url);
  await tabUntil(page, /\S/, { inside: FOLLOW_UP }); await expectFocusVisibleAndUncovered(page);
  await page.keyboard.press('Enter'); await expect(page).toHaveURL(/\/findings\//);
});

for (const width of [1280, 360, 320]) for (const theme of ['light', 'dark'] as const)
  test(`NFR-A11Y-05: the follow-up lines on S-10 at ${width}px, ${theme}: no serious violation; overdue said in words`, async ({ browser }) => {
    const { fx, url } = await projectWithFollowUp();
    const page = await signedIn(browser, fx.members.owner);
    await page.setViewportSize({ width, height: 900 }); await page.emulateMedia({ colorScheme: theme });
    await openProject(page, url);
    await expectNoSeriousA11yViolations(page, `S-10 follow-up ${width} ${theme}`);
    await expect(page.locator(FOLLOW_UP).getByText(new RegExp(`^${PROJECT_COPY.wasDue('\\d{1,2} [A-Z][a-z]{2} \\d{4}')}$`)).first()).toBeVisible();
    // spec 7.1: the word Overdue (the first red element, on the stage's Overdue line) is drawn in the overdue role (red), the
    // rest of its line, the count, in ink
    const [word, role, rest] = await page.locator('.followup-overdue').first().evaluate((el) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--color-overdue)';
      el.parentElement!.appendChild(probe);
      const colours = [getComputedStyle(el).color, getComputedStyle(probe).color, getComputedStyle(el.parentElement!).color];
      probe.remove();
      return colours;
    });
    expect(word).toBe(role);
    expect(rest).not.toBe(role);
  });

test('NFR-A11Y-02 FR-FUP-06: the reminder setting on S-21 toggles by keyboard and announces "Reminder emails turned off."', async ({ browser }) => {
  const fx = await buildOrg({ label: 'fups' });
  const page = await signedIn(browser, fx.members.assessor);
  requireWired('ReminderEmailsSetting', 'ACC-b, S-21');
  await page.goto('/account');
  await tabUntil(page, /Email me when a mitigation assigned to me is due or overdue/);
  await page.keyboard.press('Space'); await expect(page.getByRole('status').filter({ hasText: 'Reminder emails' })).toHaveText('Reminder emails turned off.');   // 7.4.2 row S-21
  await page.keyboard.press('Space'); await expect(page.getByRole('status').filter({ hasText: 'Reminder emails turned on.' })).toHaveText('Reminder emails turned on.');
});
