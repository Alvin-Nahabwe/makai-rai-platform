import path from 'node:path';
import type { FixtureUser } from '../../__tests__/helpers/fixture';

/**
 * Pure data/path helpers for the fixture manifest `auth.setup.ts` writes.
 * Deliberately its own file, separate from `auth.setup.ts`: that file calls
 * Playwright's `test`/`setup` at module scope, so a future spec importing
 * `storageStatePathFor`/`MANIFEST_PATH`/`FixtureManifest` FROM `auth.setup.ts`
 * would also execute that top-level `setup(...)` registration as a side
 * effect of the import — surfaced by the `simplify` altitude pass. This
 * module has no `test`/`setup` call anywhere, so importing it is inert.
 */

export const AUTH_DIR = path.join(__dirname, '.auth');

export type FixtureManifestUser = FixtureUser & { storageStatePath: string };

export type FixtureManifest = {
  orgs: readonly [{ id: string; slug: string }, { id: string; slug: string }];
  users: FixtureManifestUser[];
};

export const MANIFEST_PATH = path.join(AUTH_DIR, 'manifest.json');

/** Deterministic from (orgSlug, role, index) alone, so a spec that already
 * has a `FixtureUser` (e.g. read back from the manifest) never has to
 * recompute or guess the file name. */
export function storageStatePathFor(user: Pick<FixtureUser, 'orgSlug' | 'role' | 'index'>): string {
  return path.join(AUTH_DIR, `${user.orgSlug}--${user.role}--${user.index}.json`);
}
