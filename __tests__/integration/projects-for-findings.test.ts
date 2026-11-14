import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PROJECT_COPY } from '@/lib/project/copy';
import { resetDb, testDb } from '../helpers/db';
import { sessionFor } from '../helpers/authSession';
import { addProject, buildOrg, type OrgFixture } from '../helpers/recordFixture';

/**
 * The Projects page under `?for=findings` (plan 1A Task 12, ruling L2-65; security obligations S1 to S3): the rail's
 * Findings link. A `last` that is one of the organisation's own projects goes to that project's findings; anything else
 * (another organisation's project, a deleted one, not a UUID, repeated, or an upper-case copy of a real id, which isUuid
 * accepts but which equals no row's id, as row ids are lower case) gives exactly what no `last` gives.
 * The real page runs against the real database behind the real gates; only the session is mocked.
 */
vi.mock('next/navigation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/navigation')>()), useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), useParams: () => ({ slug: 'x' }),
}));

type Query = Record<string, string | string[] | undefined>;
type Outcome = { redirect: string } | { html: string } | { error: string };

let fx: OrgFixture;
let fxB: OrgFixture;
let one: { id: string };
let two: { id: string };
let foreign: { id: string };

async function open(f: OrgFixture, query: Query, slug = f.org.slug): Promise<Outcome> {
  const { default: ProjectsPage } = await import('@/app/(authenticated)/orgs/[slug]/projects/page');
  try {
    const element = await ProjectsPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(query) });
    return { html: renderToStaticMarkup(element) };
  } catch (e) {
    const digest = (e as { digest?: unknown }).digest;
    if (typeof digest === 'string' && digest.startsWith('NEXT_REDIRECT;')) return { redirect: digest.split(';')[2] };
    return { error: typeof digest === 'string' ? digest : String(e) };
  }
}

beforeEach(async () => {
  await resetDb();
  fx = await buildOrg();
  fxB = await buildOrg({ label: 'b' });
  one = await addProject(fx, { name: 'First project' });
  two = await addProject(fx, { name: 'Second project' });
  foreign = await addProject(fxB, { name: 'Foreign project' });
  sessionFor(fx.members.viewer.userId);
});

describe('S-32 under ?for=findings', () => {
  it('L2-65 S1 S3: an own project in `last` redirects to that project\'s findings page', async () => {
    expect(await open(fx, { for: 'findings', last: two.id })).toEqual({ redirect: `/orgs/${fx.org.slug}/projects/${two.id}/findings` });
  });

  it('L2-65: an archived own project in `last` redirects too (its findings page is readable)', async () => {
    const shelved = await addProject(fx, { name: 'Shelved project', archived: true });
    expect(await open(fx, { for: 'findings', last: shelved.id })).toEqual({ redirect: `/orgs/${fx.org.slug}/projects/${shelved.id}/findings` });
  });

  it('L2-65 S2: a foreign, deleted, malformed, upper-case or repeated `last` gives a result deep-equal to no `last`', async () => {
    const plain = await open(fx, { for: 'findings' });
    expect(plain).toHaveProperty('html');
    const deleted = await addProject(fx, { name: 'Gone project' });
    await testDb.project.delete({ where: { id: deleted.id } });
    const plainAfterDelete = await open(fx, { for: 'findings' });
    const cases: Query[] = [
      { for: 'findings', last: foreign.id },
      { for: 'findings', last: deleted.id },
      { for: 'findings', last: randomUUID() },
      { for: 'findings', last: 'not-a-uuid' },
      { for: 'findings', last: one.id.toUpperCase() },
      { for: 'findings', last: [one.id, two.id] },
      { for: 'findings', last: '' },
    ];
    for (const q of cases) expect(await open(fx, q), JSON.stringify(q.last)).toEqual(plainAfterDelete);
    expect(plainAfterDelete).toEqual(plain);
  });

  it('L2-65: with exactly one project and no `last`, the page redirects to its findings; one archived project counts', async () => {
    const solo = await buildOrg({ label: 'solo' });
    const only = await addProject(solo, { name: 'Only project' });
    sessionFor(solo.members.viewer.userId);
    expect(await open(solo, { for: 'findings' })).toEqual({ redirect: `/orgs/${solo.org.slug}/projects/${only.id}/findings` });
    const shelf = await buildOrg({ label: 'shelf' });
    const shelved = await addProject(shelf, { name: 'Only shelved', archived: true });
    sessionFor(shelf.members.viewer.userId);
    expect(await open(shelf, { for: 'findings' })).toEqual({ redirect: `/orgs/${shelf.org.slug}/projects/${shelved.id}/findings` });
  });

  it('L2-65: with two projects and no `last`, the page says "Choose a project to see its findings." and every project links to its findings', async () => {
    const shelved = await addProject(fx, { name: 'Shelved project', archived: true });
    const out = await open(fx, { for: 'findings' });
    if (!('html' in out)) throw new Error(JSON.stringify(out));
    expect(PROJECT_COPY.chooseForFindings).toBe('Choose a project to see its findings.');
    // the line is the lead of the kit's page header, right under the h1 (F6 b: the header's own bottom margin separates it from Active)
    expect(out.html).toContain(`<h1 class="ui-page-header__title">${PROJECT_COPY.allProjects.heading}</h1></div><div class="ui-page-header__lead">${PROJECT_COPY.chooseForFindings}</div>`);
    for (const p of [one, two, shelved]) expect(out.html).toContain(`href="/orgs/${fx.org.slug}/projects/${p.id}/findings"`);
    expect(out.html).not.toMatch(new RegExp(`href="/orgs/${fx.org.slug}/projects/[0-9a-f-]{36}"`));
    expect(out.html).toContain(`>${PROJECT_COPY.allProjects.heading}</h1>`);
  });

  it('L2-65 (amended, F7): with no project at all, for=findings renders the page exactly as without it', async () => {
    const empty = await buildOrg({ label: 'empty' });
    sessionFor(empty.members.viewer.userId);
    const plain = await open(empty, {});
    expect(plain).toHaveProperty('html');
    expect(await open(empty, { for: 'findings' })).toEqual(plain);
    expect(await open(empty, { for: 'findings', last: one.id })).toEqual(plain);
  });

  it('L2-65: without for=findings (none, or another value), the page is as today and `last` is ignored', async () => {
    const today = await open(fx, {});
    if (!('html' in today)) throw new Error(JSON.stringify(today));
    expect(today.html).not.toContain(PROJECT_COPY.chooseForFindings);
    expect(today.html).toContain(`href="/orgs/${fx.org.slug}/projects/${one.id}"`);
    expect(await open(fx, { last: one.id })).toEqual(today);
    expect(await open(fx, { for: 'other', last: one.id })).toEqual(today);
    expect(await open(fx, { for: ['findings', 'findings'], last: one.id })).toEqual(today);
  });

  it('L2-65: "Show more" keeps the mode: ?for=findings&shown=100 under for=findings, ?shown=100 otherwise', async () => {
    for (let i = 0; i < 50; i++) await addProject(fx, { name: `Project ${String(i).padStart(3, '0')}` });
    const chosen = await open(fx, { for: 'findings' });
    const plain = await open(fx, {});
    if (!('html' in chosen) || !('html' in plain)) throw new Error('expected pages');
    expect(chosen.html).toMatch(/<a [^>]*href="\?for=findings&amp;shown=100"[^>]*>Show more<\/a>/);
    expect(plain.html).toMatch(/<a [^>]*href="\?shown=100"[^>]*>Show more<\/a>/);
    const all = await open(fx, { for: 'findings', shown: '100' });
    if (!('html' in all)) throw new Error(JSON.stringify(all));
    expect(all.html).not.toContain('Show more');
    expect(all.html).toContain(PROJECT_COPY.chooseForFindings);
  });

  it('L2-65 S1: a person of another organisation gets the page\'s ordinary refusal, whatever `last` says', async () => {
    sessionFor(fxB.members.owner.userId);
    const refusal = await open(fx, {}, fx.org.slug);
    expect(refusal).toHaveProperty('error');
    for (const q of [{ for: 'findings' }, { for: 'findings', last: one.id }, { for: 'findings', last: foreign.id }] as Query[]) {
      expect(await open(fx, q, fx.org.slug), JSON.stringify(q)).toEqual(refusal);
    }
  });
});
