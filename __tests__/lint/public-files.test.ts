import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files under `public/` are served to anyone, so they carry no internal notes. Indexing stays
 * disallowed: `robots.txt` is exactly the two rules.
 */
const REPO_ROOT = join(__dirname, '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

describe('public files', () => {
  it('robots.txt is exactly the two rules, with no comment', () => {
    expect(read('public/robots.txt')).toBe('User-agent: *\nDisallow: /\n');
  });

  it('service-parameters.json has no `source` key', () => {
    expect(JSON.parse(read('public/service-parameters.json'))).not.toHaveProperty('source');
  });
});
