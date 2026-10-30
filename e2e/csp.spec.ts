import 'dotenv/config';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {
  test,
  expect,
  request as pwRequest,
  type APIResponse,
  type Browser,
  type BrowserContext,
} from '@playwright/test';
import type { OrgRole } from '@prisma/client';
import { testDb } from '../__tests__/helpers/db';
import { buildPlatformAdmin, type FixtureAccount } from '../__tests__/helpers/recordFixture';
import { MANIFEST_PATH, type FixtureManifest, type FixtureManifestUser } from './fixtures/manifest';
import { fetchRetryingReset } from './helpers/retryFetch';

/**
 * P5: every page route loads and hydrates under the PRODUCTION Content-Security-Policy
 * with zero violations.
 *
 * Why a route sweep and not a fixture in each spec: CI serves the app with `next start`
 * and no nginx, so no response carries the policy and no existing spec could ever have
 * caught a blocked script. This spec puts nginx's policy, parsed from the same
 * `default.conf` production uses, onto every response, then visits all of the app's pages.
 * A page that needs `eval`, an inline script the policy forbids, or a third-party origin
 * fails here, in CI, before it fails for a user. A new `page.tsx` is covered automatically:
 * the route list comes from the page files. The number of routes actually visited must equal
 * the number of page files counted a second, independent way (a walk of `app/`, any
 * extension), so a page the list missed, or a visit that did not finish, fails the run.
 *
 * What "hydrates" means here, concretely: after the page settles, React must have attached
 * to the server-rendered DOM (scripts the policy blocked never run, so nothing attaches),
 * then one same-origin link is followed so the navigation, including the client router's own
 * fetches under `connect-src`, runs under the policy as well. `window.__csp` must be empty.
 *
 * The dynamic routes need ids the shared fixture does not carry (a project, an
 * invitation token), so this spec makes them over the app's own API in
 * `beforeAll`, the way `role-matrix.spec.ts` does. It touches nothing in the shared setup.
 * The two `/admin/*` pages redirect anyone who is not a platform admin, so the spec signs in
 * as a platform administrator of its own, made by `buildPlatformAdmin()` (see `beforeAll`).
 */

// Runs against `next start`; locally `next dev` serves different (eval-using) code and
// a database is needed. CI is where this has a server and a database.
test.skip(!process.env.CI, 'needs npm run start');

/** The platform admin's login is rate limited per client address, so it gets its own,
 * the same way `auth.setup.ts` gives each seat one. */
const ADMIN_CLIENT_IP = '10.43.0.1';

/** The one policy header nginx sets, read from the file nginx serves. */
function productionCsp(): string {
  const conf = fs.readFileSync('docker/nginx/default.conf', 'utf8');
  const found = [...conf.matchAll(/^\s*add_header\s+Content-Security-Policy\s+"([^"]+)"\s+always;/gm)];
  if (found.length !== 1) {
    throw new Error(`expected exactly one Content-Security-Policy in default.conf, found ${found.length}`);
  }
  return found[0][1];
}

/** Every `page.tsx` git tracks: the source of the route list. Never empty, or the sweep
 * would visit nothing and pass. */
function pageFiles(): string[] {
  const files = execFileSync('git', ['ls-files', 'app/**/page.tsx', 'app/page.tsx'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  if (files.length === 0) throw new Error('git ls-files found no page.tsx under app/, so there is nothing to sweep');
  return files;
}

/** The number of page files, counted without git and without caring about the extension.
 * The route list knows only `page.tsx`; a page written as `page.jsx` or `page.mdx` is
 * missing from it, and only a count that does not share its blind spot can tell. */
function pageFileCount(): number {
  return fs
    .readdirSync('app', { recursive: true, encoding: 'utf8' })
    .filter((entry) => /(^|[\\/])page\.(tsx?|jsx?|mdx?)$/.test(entry)).length;
}

/**
 * Pages with no same-origin link to follow, each with the reason it has none. A page that
 * has no link and is not listed fails the sweep, so a new page without links forces a
 * decision; a page listed here that gains a link fails too, so this cannot go stale.
 * Empty today: every page has one (the anonymous invitation page's is its sign-in link).
 */
const NO_LINK_TO_FOLLOW: Record<string, string> = {};

/**
 * Pages whose data loader is still a typed stub that throws, so the page answers 500 by design until its
 * producer fills the loader (the K0b shell of S-12). While the stub's `// CONTRACT_STUB: <producer>` marker sits
 * directly above its export (the check `__tests__/lint/no-contract-stubs.test.ts` uses), the sweep expects exactly
 * a 500 from the page and skips the CSP and hydration checks for that page only. The producer deletes the marker
 * in the commit that fills the stub, and the page then goes through every check like any other, so this entry
 * removes itself and a page listed here that answers anything else while the marker is present fails.
 */
const PENDING_PAGES: Record<string, { producer: string; stubFile: string; stubFn: string }> = {
  '/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]': {
    producer: 'DEC-b',
    stubFile: 'lib/question/panel.ts',
    stubFn: 'loadQuestionPanel',
  },
};

/** True while `fn` is exported directly below its own `// CONTRACT_STUB: <producer>` marker in `source`. */
function stubMarkerPresent(source: string, producer: string, fn: string): boolean {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`// CONTRACT_STUB: ${escape(producer)}\\s*\\n\\s*export (async )?(function|const) ${escape(fn)}\\b`).test(source);
}

/** The text a pending page is recorded under, or null when the page goes through every check. */
function pendingFor(template: string): string | null {
  const entry = PENDING_PAGES[template];
  if (!entry) return null;
  return stubMarkerPresent(fs.readFileSync(entry.stubFile, 'utf8'), entry.producer, entry.stubFn)
    ? `pending: ${entry.producer} fills ${entry.stubFn}`
    : null;
}

type Who = 'anonymous' | 'owner' | 'admin';
type Route = { file: string; template: string; path: string; who: Who };

type DynamicValues = {
  slug?: string;
  /** Keyed by the page file's route (route groups removed), so `[id]` can mean a project
   * in one place and a different record in another. */
  ids: Record<string, string | undefined>;
  token?: string;
};

/** A dynamic segment's value, or a failure that names the segment. Without this a missing
 * value becomes the URL `/invitations/undefined`, which renders a valid page and passes. */
function required(value: string | undefined, segment: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`csp sweep: the ${segment} segment has no value, so its page would be visited at a made-up URL`);
  }
  return value;
}

/** `app/(authenticated)/orgs/[slug]/projects/[id]/page.tsx` -> `/orgs/[slug]/projects/[id]` */
function routeTemplate(file: string): string {
  const segments = file
    .replace(/^app\//, '')
    .replace(/\/?page\.tsx$/, '')
    .split('/')
    .filter((s) => s && !/^\(.+\)$/.test(s));
  return '/' + segments.join('/');
}

function whoFor(file: string): Who {
  if (file.startsWith('app/(public)/')) return 'anonymous';
  if (file.startsWith('app/(authenticated)/admin/')) return 'admin';
  if (file === 'app/page.tsx' || file.startsWith('app/(authenticated)/')) return 'owner';
  throw new Error(`${file}: not under a route group this spec knows how to sign in for`);
}

function buildRoutes(values: DynamicValues): Route[] {
  return pageFiles().map((file) => {
    const template = routeTemplate(file);
    const path = template.replace(/\[([^\]]+)\]/g, (_whole, name: string) => {
      if (name === 'slug') return required(values.slug, '[slug]');
      if (name === 'token') return required(values.token, '[token]');
      if (name === 'id') return required(values.ids[template], `[id] (${template})`);
      // S-12 only: the first stage, and a question that exists in the content the server reads (data/questionBank.json).
      if (name === 'stage') return 'pre-processing';
      if (name === 'questionId') return 'Q-PP-01';
      throw new Error(`${file}: dynamic segment [${name}] has no value in this spec`);
    });
    return { file, template, path, who: whoFor(file) };
  });
}

function seat(manifest: FixtureManifest, orgSlug: string, role: OrgRole, index: 0 | 1): FixtureManifestUser {
  const found = manifest.users.find((u) => u.orgSlug === orgSlug && u.role === role && u.index === index);
  if (!found) throw new Error(`csp: no fixture seat for ${orgSlug}/${role}/${index}`);
  return found;
}

async function ok(res: APIResponse, what: string) {
  if (!res.ok()) throw new Error(`csp setup: ${what} failed with ${res.status()}`);
  return res.json();
}

/** A context that serves every response with the production policy, and records every
 * `securitypolicyviolation` into `window.__csp` before any page script runs. */
async function policedContext(
  browser: Browser,
  csp: string,
  options: { storageState?: string; clientIp?: string } = {},
) {
  const extraHeaders: Record<string, string> = options.clientIp ? { 'x-forwarded-for': options.clientIp } : {};
  const context = await browser.newContext({
    storageState: options.storageState,
    extraHTTPHeaders: extraHeaders,
  });
  // Playwright's own defaults wait without limit. A page the policy broke is exactly the
  // case where an element never appears, and the run must reach its list of failures.
  context.setDefaultTimeout(10_000);
  context.setDefaultNavigationTimeout(30_000);
  await context.route('**/*', async (route) => {
    // maxRedirects 0: hand 3xx responses to the browser, which follows them itself,
    // so cookies and `Location` behave exactly as they do without interception.
    // A GET that is reset is sent once more (e2e/helpers/retryFetch.ts): one reset must not turn --fail-on-flaky-tests red.
    const response = await fetchRetryingReset(route.request().method(), () =>
      route.fetch({
        maxRedirects: 0,
        headers: { ...route.request().headers(), ...extraHeaders },
      }),
    );
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': csp } });
  });
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: string[] };
    w.__csp = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
    });
  });
  return context;
}

type Visit = {
  problems: string[];
  /** True only if every check below ran to its end. A visit that threw part-way is not
   * counted as visited, so the count at the end of the run cannot hide it. */
  completed: boolean;
  /** The link that was followed, or null if the page had none. */
  followed: string | null;
  /** Why the page was only checked for its 500 (see PENDING_PAGES), or null. */
  pending: string | null;
};

/** Loads one route, checks it hydrated, then follows one same-origin link. */
async function visit(context: BrowserContext, route: Route): Promise<Visit> {
  const problems: string[] = [];
  let completed = false;
  let followed: string | null = null;
  const pending = pendingFor(route.template);
  const page = await context.newPage();
  const consoleCsp: string[] = [];
  page.on('console', (m) => {
    if (/content security policy/i.test(m.text())) consoleCsp.push(m.text().slice(0, 200));
  });

  try {
    const response = await page.goto(route.path, { waitUntil: 'networkidle' });
    if (pending !== null) {
      // The stub throws, so exactly 500 is the expected answer; the CSP and hydration checks below do not apply.
      if (response?.status() !== 500) {
        problems.push(`${route.path}: ${pending} but the page answered ${response?.status()}, not 500: remove it from PENDING_PAGES or fill the stub`);
      }
      completed = true;
      return { problems, completed, followed, pending };
    }
    if (!response || response.status() >= 400) {
      problems.push(`${route.path}: HTTP ${response?.status()}`);
    }
    const landed = new URL(page.url()).pathname;
    // `/` sends a signed-in user on to their organisation; everything else must stay put,
    // or it is the redirect page being tested rather than this one (the admin pages
    // redirect a non-admin to `/`).
    if (landed !== route.path && !(route.path === '/' && landed.startsWith('/orgs/'))) {
      problems.push(`${route.path}: landed on ${landed}`);
    }

    // Hydrated: React has attached to the server-rendered DOM. Scripts the policy blocked
    // never run, so nothing attaches. Every page must pass this, whether or not it has a
    // link to click.
    const hydrated = await page
      .waitForFunction(
        () =>
          [...document.querySelectorAll('body *')].some((el) =>
            Object.keys(el).some((k) => k.startsWith('__reactFiber$')),
          ),
        undefined,
        { timeout: 5_000 },
      )
      .then(
        () => true,
        () => false,
      );
    if (!hydrated) problems.push(`${route.path}: React did not hydrate`);

    // Follow one link to somewhere else, so the navigation itself (including the client
    // router's own fetches, which `connect-src` governs) runs under the policy too. A page
    // with no such link is recorded, and must be listed in NO_LINK_TO_FOLLOW.
    const href = await page.locator('a[href^="/"]').evaluateAll(
      (links, here) =>
        links
          .map((a) => a as HTMLAnchorElement)
          .filter((a) => !a.hasAttribute('download') && !a.target)
          .filter((a) => new URL(a.href).pathname !== here && !new URL(a.href).pathname.startsWith('/api/'))
          .map((a) => a.getAttribute('href'))[0] ?? null,
      landed,
    );
    if (href !== null) {
      followed = href;
      await Promise.all([
        page.waitForURL((url) => url.pathname !== landed, { timeout: 10_000 }),
        page.locator(`a[href="${href}"]`).first().click(),
      ]);
      await page.waitForLoadState('networkidle');
    }

    const violations = await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
    if (violations.length > 0) problems.push(`${route.path}: CSP violations ${JSON.stringify(violations)}`);
    if (consoleCsp.length > 0) problems.push(`${route.path}: CSP console messages ${JSON.stringify(consoleCsp)}`);
    completed = true;
  } catch (e) {
    problems.push(`${route.path}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  } finally {
    await page.close();
  }
  return { problems, completed, followed, pending: null };
}

let manifest: FixtureManifest;
let values: DynamicValues;
let adminUser: FixtureAccount;

test.beforeAll(async () => {
  manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  const org = manifest.orgs[0];
  const owner = seat(manifest, org.slug, 'owner', 0);

  const api = await pwRequest.newContext({ baseURL: test.info().project.use.baseURL, storageState: owner.storageStatePath });
  try {
    const project = await ok(
      await api.post(`/api/v1/orgs/${org.slug}/projects`, {
        data: { name: `CSP route sweep (${org.slug})`, aiSystemType: 'classification' },
      }),
      'project create',
    );

    // The raw token is only ever returned here, in the create response.
    const invitation = await ok(
      await api.post(`/api/v1/orgs/${org.slug}/members`, {
        data: { email: `csp-sweep-${Date.now()}@fixture.test`, role: 'viewer' },
      }),
      'invitation create',
    );

    values = {
      slug: org.slug,
      token: invitation.token,
      ids: {
        '/orgs/[slug]/projects/[id]': project.id,
        '/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]': project.id,
      },
    };
  } finally {
    await api.dispose();
  }

  // `/admin/*` redirects anyone whose platform role is not `admin`. The platform administrator
  // holds no membership (NFR-SEC-04 (d): the membership lock refuses the platform role for a
  // member), so the spec signs in as an administrator account of its own instead of promoting a
  // fixture seat (00-contract.md, revocation table, membership lock row).
  adminUser = await buildPlatformAdmin();
});

test.afterAll(async () => {
  await testDb.$disconnect();
});

test('every page route hydrates under the production CSP', async ({ browser }) => {
  // A passing run takes about 20 seconds. A failing one waits out every broken page, and
  // must still reach the assertion that lists them all, so the budget is generous.
  test.setTimeout(600_000);
  const csp = productionCsp();
  const routes = buildRoutes(values);
  // Counted a different way from the route list, and before any visit, so the final
  // comparison cannot be satisfied by the loop's own bookkeeping.
  const expectedCount = pageFileCount();
  expect(expectedCount, 'a walk of app/ found no page files').toBeGreaterThan(0);
  const owner = seat(manifest, manifest.orgs[0].slug, 'owner', 0);

  const contexts: Record<Who, BrowserContext> = {
    anonymous: await policedContext(browser, csp),
    owner: await policedContext(browser, csp, { storageState: owner.storageStatePath }),
    admin: await policedContext(browser, csp, { clientIp: ADMIN_CLIENT_IP }),
  };

  const problems: string[] = [];
  const visited: string[] = [];
  const withoutLink: string[] = [];
  const pendingPages: string[] = [];
  try {
    // The platform admin signs in through the real form, under the same policy, so the
    // sign-in flow is covered too. If it fails, the `/admin/*` pages are reported as
    // redirected below; the rest of the sweep still runs.
    const login = await contexts.admin.newPage();
    try {
      await login.goto('/login');
      await login.fill('#email', adminUser.email);
      await login.fill('#password', adminUser.password);
      await login.locator('button[type="submit"]').click();
      await login.waitForURL((url) => url.pathname !== '/login');
      const loginViolations = await login.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
      if (loginViolations.length > 0) problems.push(`/login (submit): CSP violations ${JSON.stringify(loginViolations)}`);
    } catch (e) {
      problems.push(`/login (submit): ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    } finally {
      await login.close();
    }

    for (const route of routes) {
      const result = await visit(contexts[route.who], route);
      problems.push(...result.problems);
      if (result.completed) visited.push(route.template);
      if (result.pending !== null) pendingPages.push(`${route.template} (${result.pending})`);
      else if (result.completed && result.followed === null) withoutLink.push(route.template);
    }
  } finally {
    for (const context of Object.values(contexts)) {
      // Requests still in flight when a context closes would reject inside the handler.
      await context.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  }

  console.log(
    `csp sweep: ${visited.length} of ${expectedCount} page files visited; ` +
      `link followed on ${visited.length - withoutLink.length - pendingPages.length}, none to follow on ${withoutLink.length}, ` +
      `pending on ${pendingPages.length}${pendingPages.map((p) => `\n  ${p}`).join('')}`,
  );
  test.info().annotations.push({
    type: 'routes visited',
    description: `${visited.length} of ${expectedCount} page files`,
  });

  expect(problems, problems.join('\n')).toEqual([]);
  // Every page file was visited, once, to the end. The expected number comes from a count
  // taken before the loop by a different method, so skipping a visit, dropping a route, or
  // a page file the route list cannot see all leave it short or long.
  expect(visited, 'visited routes (each page once, to the end)').toHaveLength(expectedCount);
  expect(new Set(visited).size, 'a route was visited twice').toBe(visited.length);
  // Pages with no link to follow are a decision someone made, not an accident.
  expect(
    withoutLink.sort(),
    'pages with no same-origin link must match NO_LINK_TO_FOLLOW exactly',
  ).toEqual(Object.keys(NO_LINK_TO_FOLLOW).sort());
});

test('the pending-page gate follows the stub marker: present gives pending, absent gives the full checks', () => {
  const entry = PENDING_PAGES['/orgs/[slug]/projects/[id]/stages/[stage]/questions/[questionId]'];
  const stub = 'export async function loadQuestionPanel(\n  ctx: OrgContext,\n): Promise<QuestionPanelData> {\n  throw new Error();\n}\n';
  expect(stubMarkerPresent(`// CONTRACT_STUB: ${entry.producer}\n${stub}`, entry.producer, entry.stubFn), 'marker present').toBe(true);
  expect(stubMarkerPresent(stub, entry.producer, entry.stubFn), 'marker deleted by the producer').toBe(false);
  // another producer's marker, or the marker above another export, does not make this page pending
  expect(stubMarkerPresent(`// CONTRACT_STUB: DEC-a\n${stub}`, entry.producer, entry.stubFn), 'another producer').toBe(false);
  expect(stubMarkerPresent(`// CONTRACT_STUB: ${entry.producer}\n${stub.replace('loadQuestionPanel', 'somethingElse')}`, entry.producer, entry.stubFn), 'another export').toBe(false);
});
