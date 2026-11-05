import { readFileSync } from 'node:fs';
import { shText } from '../helpers/spawnText';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * FR-OPS-02, FR-OPS-03, NFR-SEC-14 (SRS lines 1149, 1155): the settings the rulings close are gone, and the one
 * secret the reminder route needs reaches the web container only, with no value in the repository.
 */

type Compose = { services: Record<string, { environment?: Record<string, unknown> }> };

// Built from parts, so this file holds neither name.
const NAMES = [['ALLOW', 'OPEN', 'REGISTRATION'].join('_'), ['ORG', 'LIMIT', 'PER', 'USER'].join('_')];

describe('the production settings', () => {
  it('FR-OPS-03: neither removed setting name appears outside migrations', () => {
    // The names may stay where something must name them to prove them gone or to tell the owner to remove them:
    // a test or e2e file that carries FR-ACC-01, FR-OPS-03 or FR-ORG-04 (the requirements that retire them: they set the
    // old name to see it ignored, or grep for its absence), and the deployment runbook's step that removes the key
    // from the server .env, which has to name it. There is no changelog in the tree.
    const hits = shText(`git grep -l --untracked -E "${NAMES.join('|')}" -- . ':!prisma/migrations' || true`).split('\n').filter(Boolean);
    const allowed = (f: string) =>
      f === 'docs/runbooks/deployment.md' || (/^(__tests__|e2e)\//.test(f) && /FR-ACC-01|FR-OPS-03|FR-ORG-04/.test(readFileSync(f, 'utf8')));
    expect(hits.filter((f) => !allowed(f))).toEqual([]);
    expect(hits, 'the search finds the files that prove the names gone, so an empty rest means no reader').toContain('__tests__/integration/open-registration-removed.test.ts');
  });

  it('NFR-SEC-14 FR-OPS-02: the token reaches only the web container and has no value in the repository', () => {
    const compose = loadYaml(readFileSync('docker/docker-compose.prod.yml', 'utf8')) as Compose;
    expect(compose.services.nextjs.environment?.REMINDER_JOB_TOKEN).toBe('${REMINDER_JOB_TOKEN:-}');
    for (const [name, svc] of Object.entries(compose.services)) {
      if (name !== 'nextjs') expect({ name, has: JSON.stringify(svc.environment ?? {}).includes('REMINDER_JOB_TOKEN') }).toEqual({ name, has: false });
    }
    const example = readFileSync('.env.example', 'utf8');
    expect(example).toMatch(/^REMINDER_JOB_TOKEN=$/m);
    expect(example).toContain('openssl rand -hex 32');
    expect(example).toContain('Never paste it into an AI session.');
  });
});
