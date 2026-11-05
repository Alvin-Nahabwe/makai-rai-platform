import { readFileSync } from 'node:fs';
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * FR-OPS-02, FR-OPS-03, NFR-SEC-14 (SRS lines 1149, 1155): the settings the rulings close are gone, and the one
 * secret the reminder route needs reaches the web container only, with no value in the repository.
 */

type Compose = { services: Record<string, { environment?: Record<string, unknown> }> };

describe('the production settings', () => {
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
