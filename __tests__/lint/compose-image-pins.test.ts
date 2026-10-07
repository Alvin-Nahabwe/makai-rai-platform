import { describe, it, expect } from 'vitest';
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
 * The postgres tag stays on major 16. A new Postgres major cannot start on a
 * data directory written by the previous one, so a digest bump that crossed
 * majors would take the database down on the next `up -d`.
 *
 * Both files are read with regular expressions, as the neighbouring lint tests
 * do: the images are found by scanning the files, not listed here, so a service
 * or build stage added later is checked the moment it exists.
 */

const REPO_ROOT = join(__dirname, '../..');
const COMPOSE_PATH = 'docker/docker-compose.prod.yml';
const DOCKERFILE_PATH = 'docker/Dockerfile';

const PINNED_BY_DIGEST = /@sha256:[0-9a-f]{64}$/;

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), 'utf8');
}

/** Every `image:` value in the compose file. Services that `build:` have none. */
function composeImages(): string[] {
  return [...read(COMPOSE_PATH).matchAll(/^\s*image:\s*['"]?([^\s'"#]+)/gm)].map((m) => m[1]);
}

/**
 * The image each Dockerfile `FROM` names. A `FROM` that names an earlier stage
 * (`FROM base AS deps`) is not an image, so it is left out.
 */
function dockerfileImages(): string[] {
  const stages = new Set<string>();
  const images: string[] = [];
  for (const line of read(DOCKERFILE_PATH).split('\n')) {
    const from = /^\s*FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(line);
    if (!from) continue;
    if (!stages.has(from[1])) images.push(from[1]);
    if (from[2]) stages.add(from[2]);
  }
  return images;
}

describe('production images are pinned by digest', () => {
  it('every production image is pinned by digest', () => {
    const images = composeImages();
    // Guards against the scan matching nothing and the loop passing over an
    // empty set.
    expect(images.length, `${COMPOSE_PATH}: found no image: lines`).toBeGreaterThan(0);
    const unpinned = images.filter((image) => !PINNED_BY_DIGEST.test(image));
    expect(unpinned, `${COMPOSE_PATH}: images without @sha256:<64 hex>`).toEqual([]);
  });

  it('postgres stays on major 16', () => {
    const postgres = composeImages().filter((image) => image.startsWith('postgres:'));
    expect(postgres, `${COMPOSE_PATH}: expected exactly one postgres image`).toHaveLength(1);
    expect(postgres[0], 'a new Postgres major cannot read the existing data volume').toMatch(
      /^postgres:16(?![0-9])/,
    );
  });

  it('every Dockerfile FROM is pinned by digest', () => {
    const images = dockerfileImages();
    expect(images.length, `${DOCKERFILE_PATH}: found no FROM image`).toBeGreaterThan(0);
    const unpinned = images.filter((image) => !PINNED_BY_DIGEST.test(image));
    expect(unpinned, `${DOCKERFILE_PATH}: FROM images without @sha256:<64 hex>`).toEqual([]);
  });
});
