import { expect } from '@playwright/test';
import { cleanText } from '../../__tests__/helpers/contentQuestions';

/** Lists the projects of the organisation over the owner's API. */
export type ProjectList = () => Promise<Array<{ name: string; description: string | null }>>;

/**
 * The names and descriptions of the organisation's projects, with the whitespace collapsed the way
 * `readWords` collapses it. It fails when the list is empty, because an empty list would pass for an
 * organisation with nothing in it (the crawl creates a project first, so there is one).
 *
 * Moved unchanged from e2e/claims-crawl.spec.ts so that e2e/vocabulary-first-use.spec.ts skips the same team-typed texts
 * (ruling X-1 (3)).
 */
export async function projectTexts(list: ProjectList): Promise<string[]> {
  const projects = await list();
  expect(projects.length, 'the organisation has the crawl project at least').toBeGreaterThan(0);
  return projects
    .flatMap((p) => [p.name, p.description ?? ''])
    .map((t) => cleanText(t))
    .filter((t) => t.length > 0);
}
