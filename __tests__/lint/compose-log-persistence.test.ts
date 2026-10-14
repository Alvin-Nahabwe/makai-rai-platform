import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Every service in the production compose file must send its output to the
 * host journal, not to a container-owned file.
 *
 * Opened 2026-09-01 for DEP-07. `lib/security-logger.ts` writes the audit
 * trail -- logins, lockouts, admin actions, membership changes, evidence
 * uploads -- as JSON to stdout, and nothing collected it. Docker's default
 * `json-file` driver stores that stream at
 * `/var/lib/docker/containers/<id>/<id>-json.log`, a path that is DELETED
 * when the container is removed. `docker compose up -d --build` removes and
 * recreates the container, so every redeploy destroyed the audit trail.
 *
 * This was not a hypothetical. On the production host the nextjs container
 * started 2026-08-31T07:15:40Z, while nginx's own log records a successful
 * login, two membership additions, an invitation registration and a password
 * change between 29 and 31 August -- all of them BEFORE that start time, and
 * none of them recoverable, because the container that logged them is gone.
 *
 * The obvious fix is a false fix, and it is the one most guides suggest.
 * `/etc/docker/daemon.json` on the host already carried
 * `{"max-size":"10m","max-file":"5"}` and the running container inherited it
 * (`docker inspect -f '{{.HostConfig.LogConfig}}'` ->
 * `json-file map[max-file:5 max-size:10m]`). Those options bound DISK USE.
 * They do not make the file outlive its container, and json-file has no
 * time-based rotation at all, so a retention period cannot be expressed in
 * it. Verified experimentally before this test was written: a marker line was
 * written to a throwaway container, located in its json-file, and the file was
 * confirmed GONE once the container was removed.
 *
 * `journald` moves the stream to a host-owned store whose lifetime is
 * independent of any container, and which does support time-based retention
 * (`MaxRetentionSec`). The retention period itself lives in journald's
 * configuration on the host, NOT here -- see `docs/runbooks/deployment.md`.
 * This test guards the half that lives in the repository: that the compose
 * file keeps directing output there.
 *
 * The service list is GENERATED from the file rather than written down, per
 * AGENTS.md §3. A hand-written list would pass vacuously for the next service
 * someone adds, which is precisely the service whose logs nobody thought about.
 */

const COMPOSE_PATH = 'docker/docker-compose.prod.yml';

/**
 * Minimal indentation-driven reader for the one shape this file has.
 *
 * Deliberately NOT js-yaml: when this was written it was a transitive dependency
 * with no bundled type declarations, so importing it failed `npm run verify` at the
 * typecheck step (learned the hard way in `__tests__/lint/ci-env-completeness.test.ts`).
 * Since Task 18 it is a direct devDependency with a local type shim.
 * Adding a parser plus its @types to reach four `logging:` blocks is a poor
 * trade; reading the indentation directly is enough and has no dependencies.
 */
function readServiceBlocks(yaml: string): Map<string, string[]> {
  const lines = yaml.split('\n');
  const blocks = new Map<string, string[]>();

  const servicesAt = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (servicesAt === -1) throw new Error(`${COMPOSE_PATH}: no top-level 'services:' key`);

  let current: string | null = null;
  for (const line of lines.slice(servicesAt + 1)) {
    // A non-indented, non-comment, non-blank line ends the services mapping
    // (`volumes:` at the foot of the file is the one that actually does).
    if (/^\S/.test(line)) break;
    if (/^\s*(#.*)?$/.test(line)) continue;

    const service = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (service) {
      current = service[1];
      blocks.set(current, []);
      continue;
    }
    if (current) blocks.get(current)!.push(line);
  }
  return blocks;
}

describe('production compose log persistence', () => {
  const yaml = readFileSync(COMPOSE_PATH, 'utf8');
  const services = readServiceBlocks(yaml);

  it('finds the services it is meant to be checking', () => {
    // Guards against the parser silently matching nothing and every assertion
    // below passing over an empty set -- the vacuous-pass shape AGENTS.md §2
    // makes a trigger in its own right.
    expect(services.size).toBeGreaterThanOrEqual(4);
    expect([...services.keys()]).toEqual(
      expect.arrayContaining(['nextjs', 'postgres', 'nginx', 'migrator']),
    );
  });

  it.each([...services.keys()])(
    'service %s sends its output to the host journal, not a container-owned file',
    (name) => {
      const body = services.get(name)!.join('\n');
      expect(body, `${COMPOSE_PATH}: service '${name}' has no logging: block`).toMatch(
        /^ {4}logging:[ \t]*$/m,
      );
      expect(body, `${COMPOSE_PATH}: service '${name}' must use the journald driver`).toMatch(
        /^ {6}driver:[ \t]*journald[ \t]*$/m,
      );
    },
  );

  it.each([...services.keys()])('service %s tags its journal entries', (name) => {
    const body = services.get(name)!.join('\n');
    // Without a tag every container's entries arrive under the same truncated
    // container id and `journalctl CONTAINER_TAG=...` cannot separate the app's
    // audit trail from postgres and nginx noise.
    expect(body, `${COMPOSE_PATH}: service '${name}' must set a journald tag`).toMatch(
      /^ {8}tag:[ \t]*\S+/m,
    );
  });

  it('does not also pin the json-file driver anywhere', () => {
    // The failure this whole file exists to prevent, stated as an assertion:
    // a later edit that "adds log rotation" by reinstating json-file would
    // restore size caps and silently reintroduce loss-on-redeploy.
    expect(yaml).not.toMatch(/driver:\s*json-file/);
  });
});
