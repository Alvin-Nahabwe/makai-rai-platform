import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every third-party image the production stack runs is pinned by digest.
 *
 * Opened for RL 7.7 / M0-01. `docker-compose.prod.yml` named `postgres:16-alpine`
 * and `nginx:alpine`, and `docker/Dockerfile` named `node:22-alpine` by way of an
 * `ARG`. Those are moving tags: `docker compose pull`, or an `up -d --build`
 * on a host that has since lost its cache, can change what runs without a line
 * of the repository changing, and nothing in review would show it.
 *
 * A digest makes the image content-addressed. The digest pinned here is the
 * multi-platform INDEX digest (the `Digest:` line `docker buildx imagetools
 * inspect <image:tag>` prints), not a per-platform manifest digest, so the same
 * line stays correct on any architecture. The tag is kept beside the digest so
 * a reader can see what the digest is meant to be, and so Dependabot can move
 * both together.
 *
 * The two images this project builds itself are not named in the compose file.
 * They are released by `.github/workflows/release.yml`, and the compose file
 * takes them from the environment as `${WEB_IMAGE:?message}` and
 * `${MIGRATOR_IMAGE:?message}`: Compose stops with the message when the variable
 * is unset or empty, so a host with no image reference refuses to start instead
 * of building or pulling something. Those two references count as pinned here.
 * No other variable form does: `${NAME}` and `${NAME:-default}` can resolve to
 * nothing, or to a moving tag, and `${NAME?message}` lets an empty value
 * through. The `.env` value is checked at deploy time (runbook section 8).
 *
 * The postgres tag stays on major 16. A new Postgres major cannot start on a
 * data directory written by the previous one, so a digest bump that crossed
 * majors would take the database down on the next `up -d`.
 *
 * The files are read with regular expressions, as the neighbouring lint tests
 * do, and the images are found by scanning, not listed here: a service in the
 * production compose file, a build stage, or a new tracked Dockerfile (found
 * through `git ls-files`, as `node-version-alignment.test.ts` finds them) is
 * checked the moment it exists.
 */

const REPO_ROOT = join(__dirname, '../..');
const COMPOSE_PATH = 'docker/docker-compose.prod.yml';
const DOCKERFILE_PATH = 'docker/Dockerfile';

const PINNED_BY_DIGEST = /@sha256:[0-9a-f]{64}$/;

/**
 * A compose `image:` that Compose will not start without: `${NAME:?message}`.
 * The message is required, may hold spaces and any character but `}`, and is
 * what the operator reads when Compose stops. `:?` (not `?`) is required,
 * because the colon form also refuses an empty value.
 */
const REQUIRED_VARIABLE = /^\$\{[A-Z][A-Z0-9_]*:\?[^}]+\}$/;

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Tracked files only, as `node-version-alignment.test.ts` reads them. */
function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/** The Dockerfiles among `files`, matched as `node-version-alignment.test.ts` does. */
function dockerfilesAmong(files: string[]): string[] {
  return files.filter((file) => /(^|\/)Dockerfile[^/]*$/.test(file));
}

/**
 * The images in `images` that carry no digest. A compose file may also name an
 * image by a required variable (`allowRequiredVariable`); a Dockerfile `FROM`
 * may not, so its check leaves that off.
 */
function unpinned(images: string[], allowRequiredVariable = false): string[] {
  return images.filter(
    (image) =>
      !PINNED_BY_DIGEST.test(image) && !(allowRequiredVariable && REQUIRED_VARIABLE.test(image)),
  );
}

/**
 * Every `image:` value in `compose`: a quoted string whole, a `${...}` reference
 * whole (its message holds spaces), or else up to the first space or `#`.
 */
function imagesIn(compose: string): string[] {
  return [...compose.matchAll(/^\s*image:\s*(?:'([^']*)'|"([^"]*)"|(\$\{[^}]*\})|([^\s#]+))/gm)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? m[4],
  );
}

/** Every `image:` value in the compose file. Services that `build:` have none. */
function composeImages(): string[] {
  return imagesIn(read(COMPOSE_PATH));
}

/**
 * The image each `FROM` in `dockerfile` names. Left out: a `FROM` that names an
 * earlier stage (`FROM base AS deps`; Docker compares stage names without
 * regard to case) and `FROM scratch`, which is no image and cannot carry a
 * digest. A `FROM` that ends in a backslash is not read: its image may be on
 * the next line, so it is returned as an entry that names the problem and
 * fails the digest check instead of passing `\` off as an image.
 */
function dockerfileImages(dockerfile: string): string[] {
  const stages = new Set<string>();
  const images: string[] = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    if (/^\s*FROM\b/i.test(line) && /\\\s*$/.test(line)) {
      images.push(`FROM ends in a backslash and is not scanned; put it on one line: ${line.trim()}`);
      continue;
    }
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;
    const image = from[1].toLowerCase();
    const namesStage = stages.has(image);
    if (from[2]) stages.add(from[2].toLowerCase());
    if (!namesStage && image !== 'scratch') images.push(from[1]);
  }
  return images;
}

describe('production images are pinned by digest', () => {
  it('every production image is pinned by digest', () => {
    const images = composeImages();
    // Guards against the scan matching nothing and the loop passing over an
    // empty set.
    expect(images.length, `${COMPOSE_PATH}: found no image: lines`).toBeGreaterThan(0);
    expect(
      unpinned(images, true),
      `${COMPOSE_PATH}: images without @sha256:<64 hex> or a \${NAME:?message} reference`,
    ).toEqual([]);
  });

  it('still sees the third-party images beside the two required references', () => {
    const images = composeImages();
    expect(images.filter((image) => REQUIRED_VARIABLE.test(image))).toHaveLength(2);
    const literal = images.filter((image) => PINNED_BY_DIGEST.test(image));
    expect(literal.map((image) => image.split(':')[0]).sort()).toEqual(['nginx', 'postgres']);
  });

  it('postgres stays on major 16', () => {
    const postgres = composeImages().filter((image) => image.startsWith('postgres:'));
    expect(postgres, `${COMPOSE_PATH}: expected exactly one postgres image`).toHaveLength(1);
    expect(postgres[0], 'a new Postgres major cannot read the existing data volume').toMatch(
      /^postgres:16(?![0-9])/,
    );
  });

  it('every Dockerfile FROM is pinned by digest', () => {
    const dockerfiles = dockerfilesAmong(trackedFiles());
    // Guards against discovery finding nothing and the loop passing over an
    // empty set.
    expect(dockerfiles, 'no tracked Dockerfile found').toContain(DOCKERFILE_PATH);
    for (const file of dockerfiles) {
      const images = dockerfileImages(read(file));
      expect(images.length, `${file}: found no FROM image`).toBeGreaterThan(0);
      expect(unpinned(images), `${file}: FROM images without @sha256:<64 hex>`).toEqual([]);
    }
  });
});

describe('the Dockerfile scan', () => {
  const digest = `@sha256:${'a'.repeat(64)}`;
  const pinnedNode = `node:22-alpine${digest}`;
  const images = (...lines: string[]) => dockerfileImages(lines.join('\n'));

  it('compares stage names case-insensitively', () => {
    expect(
      images(`FROM ${pinnedNode} AS Base`, 'FROM base AS deps', 'FROM BASE AS runner'),
    ).toEqual([pinnedNode]);
  });

  it('skips FROM scratch, which cannot carry a digest', () => {
    expect(
      images(`FROM ${pinnedNode} AS base`, 'FROM scratch AS rootfs', 'FROM rootfs', 'FROM scratch'),
    ).toEqual([pinnedNode]);
  });

  it('fails clearly on a FROM ending in a backslash instead of reading it as an image', () => {
    const found = images('FROM --platform=linux/amd64 \\', `  ${pinnedNode} AS base`);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/backslash/);
    expect(unpinned(found)).toEqual(found);
  });

  it('still flags an image without a digest, including one after a stage reference', () => {
    const found = images('FROM node:22-alpine AS base', 'FROM base AS deps', 'FROM alpine:3 AS tools');
    expect(unpinned(found)).toEqual(['node:22-alpine', 'alpine:3']);
  });

  it('discovers every tracked Dockerfile, not one fixed path', () => {
    const files = [
      'docker/Dockerfile',
      'docker/Dockerfile.tools',
      'Dockerfile',
      'docker/docker-compose.prod.yml',
      'lib/MyDockerfile.ts',
    ];
    expect(dockerfilesAmong(files)).toEqual([
      'docker/Dockerfile',
      'docker/Dockerfile.tools',
      'Dockerfile',
    ]);
  });
});

describe('the compose image scan', () => {
  const digest = `@sha256:${'b'.repeat(64)}`;
  const web = '${WEB_IMAGE:?set WEB_IMAGE to ghcr.io/<owner>/makrai-web@sha256:\u2026}';

  it('reads a ${NAME:?message} reference whole, though its message holds spaces', () => {
    const compose = [
      '  nextjs:',
      `    image: ${web}`,
      '  postgres:',
      `    image: postgres:16-alpine${digest} # trailing comment`,
    ].join('\n');
    expect(imagesIn(compose)).toEqual([web, `postgres:16-alpine${digest}`]);
  });

  it('reads quoted images whole', () => {
    expect(imagesIn(`    image: 'nginx:1.31-alpine${digest}'\n    image: "x y"`)).toEqual([
      `nginx:1.31-alpine${digest}`,
      'x y',
    ]);
  });

  it('accepts only the required-variable form as a variable reference', () => {
    expect(unpinned([web], true)).toEqual([]);
    expect(unpinned(['${MIGRATOR_IMAGE:?set it}'], true)).toEqual([]);
    const loose = [
      '${WEB_IMAGE}',
      '${WEB_IMAGE:-ghcr.io/x/y:latest}',
      '${WEB_IMAGE?set it}',
      '${WEB_IMAGE:?}',
      '${web_image:?set it}',
      'ghcr.io/x/y:v1',
    ];
    expect(unpinned(loose, true)).toEqual(loose);
  });

  it('does not accept a required variable for a Dockerfile FROM', () => {
    expect(unpinned([web])).toEqual([web]);
  });
});
