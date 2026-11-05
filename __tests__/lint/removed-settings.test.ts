import { readFileSync } from 'node:fs';
import { shText } from '../helpers/spawnText';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * FR-OPS-02, FR-OPS-03, NFR-SEC-14 (SRS lines 1149, 1155): the settings the rulings close are gone, and the one
 * secret the reminder route needs reaches the web container only, with no value in the repository.
 */

type Compose = { services: Record<string, { environment?: Record<string, unknown> }> };

// The two runbook lines (8.5 step 8) that tell the owner to remove the retired key from the server .env, by exact text.
// A new line there that names a removed setting fails.
const RUNBOOK_LINES = ['unset_env ' + ['ORG', 'LIMIT', 'PER', 'USER'].join('_'), `grep -cE '^${['ORG', 'LIMIT', 'PER', 'USER'].join('_')}=' ../.env`];

// Built from parts, so this file holds neither name.
const NAMES = [['ALLOW', 'OPEN', 'REGISTRATION'].join('_'), ['ORG', 'LIMIT', 'PER', 'USER'].join('_')];

describe('the production settings', () => {
  it('FR-OPS-03: neither removed setting name appears outside migrations', () => {
    // The names may stay where something must name them to prove them gone or to tell the owner to remove them:
    // a test or e2e file that carries FR-ACC-01, FR-OPS-03 or FR-ORG-04 (the requirements that retire them: they set the
    // old name to see it ignored, or grep for its absence), and exactly the two deployment-runbook lines that remove the
    // key from the server .env. There is no changelog in the tree.
    const hits = shText(`git grep -n --untracked -E "${NAMES.join('|')}" -- . ':!prisma/migrations' || true`).split('\n').filter(Boolean);
    const allowedFile = (f: string) => /^(__tests__|e2e)\//.test(f) && /FR-ACC-01|FR-OPS-03|FR-ORG-04/.test(readFileSync(f, 'utf8'));
    const allowedLine = (line: string) => RUNBOOK_LINES.includes(line);
    const unexplained = hits.filter((h) => {
      const [file, , ...rest] = h.split(':');
      const text = rest.join(':');
      return file === 'docs/runbooks/deployment.md' ? !allowedLine(text) : !allowedFile(file);
    });
    expect(unexplained).toEqual([]);
    expect(hits.some((h) => h.startsWith('docs/runbooks/deployment.md:')), 'the runbook lines are still there, so the exemption is not stale').toBe(true);
    expect(hits.map((h) => h.split(':')[0]), 'the search finds the files that prove the names gone, so an empty rest means no reader')
      .toContain('__tests__/integration/open-registration-removed.test.ts');
  });

  it('NFR-SEC-14 FR-OPS-02: the token reaches only the web container and has no value in the repository', () => {
    const compose = loadYaml(readFileSync('docker/docker-compose.prod.yml', 'utf8')) as Compose;
    expect(compose.services.nextjs.environment?.REMINDER_JOB_TOKEN).toBe('${REMINDER_JOB_TOKEN:-}');
    for (const [name, svc] of Object.entries(compose.services)) {
      if (name !== 'nextjs') expect({ name, has: JSON.stringify(svc.environment ?? {}).includes('REMINDER_JOB_TOKEN') }).toEqual({ name, has: false });
    }
    // No tracked or untracked-not-ignored file anywhere holds a value for it. A test fixture with an obvious dummy value would be
    // listed here by exact path; none is needed today, because the route test builds its dummy with repeat().
    const DUMMY_VALUE_FILES: string[] = [];
    const found = shText(`git grep -n --untracked -E "REMINDER_JOB_TOKEN=[0-9a-f]{64}" || true`).split('\n').filter(Boolean)
      .filter((l) => !DUMMY_VALUE_FILES.includes(l.split(':')[0]));
    expect(found).toEqual([]);
    const example = readFileSync('.env.example', 'utf8');
    expect(example).toMatch(/^REMINDER_JOB_TOKEN=$/m);
    expect(example).toContain('openssl rand -hex 32');
    expect(example).toContain('Never paste it into an AI session.');
  });
});
