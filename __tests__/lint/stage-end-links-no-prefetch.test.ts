import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

/**
 * Fix wave item 14 (final review M10): the stage end screen (`/stages/<stage>/end`) reads the whole draft record, as the working report
 * does, so a link to it is never prefetched: a prefetch from every question page would run that read unseen. The rail's report link
 * opts out for the same reason (components/layout/ShellProject.tsx, RailProjectBlock). Every `<Link>` whose href is `stageEndHref(...)` says
 * `prefetch={false}`.
 */
it('every Link to a stage end screen opts out of prefetch', () => {
  const files = execFileSync('git', ['grep', '-l', 'stageEndHref(', '--', 'app', 'components'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
  const links: string[] = [];
  for (const file of files) {
    for (const m of readFileSync(file, 'utf8').matchAll(/<Link\b[^>]*href=\{stageEndHref\([^>]*>/g)) links.push(`${file}: ${m[0]}`);
  }
  expect(links.length, 'the end-screen links are found').toBeGreaterThanOrEqual(3);
  expect(links.filter((l) => !l.includes('prefetch={false}'))).toEqual([]);
});
