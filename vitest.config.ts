import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    globals: true,
    // Replaces lib/content/root with the fixture content bundle in every test file (G-17).
    setupFiles: ['__tests__/setup/content.ts'],
    /**
     * Integration tests share one Postgres database and call resetDb(), which
     * issues TRUNCATE ... CASCADE. With file-level parallelism one file's
     * truncate deletes rows another file just created. Serialising is the
     * simplest fix — the whole suite runs in ~2s.
     */
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test',
      APP_DATABASE_URL:
        process.env.TEST_APP_DATABASE_URL ??
        'postgresql://makrai_app:app_dev_password@localhost:5432/makrai_test',
      // The identity lane (ADR-0009): lib/data/identity.ts and lib/data/preauth.ts.
      // `identity_dev_password` is scripts/provision-app-db-role.sh's dev default,
      // provisioned only with ALLOW_DEV_DB_PASSWORD=1 (`npm run db:provision`, CI).
      IDENTITY_DATABASE_URL:
        process.env.TEST_IDENTITY_DATABASE_URL ??
        'postgresql://makrai_identity:identity_dev_password@localhost:5432/makrai_test',
      // Fix round 1, Important 2 (task-6-report.md): found while verifying
      // lib/auth.ts's new explicit `secret: requireAuthSecret()` -- this
      // env block had NO NEXTAUTH_SECRET at all (confirmed live: a probe
      // test read `process.env.NEXTAUTH_SECRET` as `undefined` inside a
      // real vitest run). Every CURRENT test mocks `lib/auth` (`vi.mock`),
      // so the real module's top-level `NextAuth({...})` call never
      // actually ran and this was harmless so far -- but the test
      // environment silently diverged from production (where
      // NEXTAUTH_SECRET is required) in exactly the dimension this fix
      // round's work is about. A dummy value, not a real secret: nothing
      // this suite does needs the signature to verify against anything
      // else, only to be a non-empty string requireAuthSecret() accepts.
      NEXTAUTH_SECRET: 'vitest-test-only-secret-not-for-any-real-use',
      // Production and CI both set this; the test env did not, and ten tests
      // relied on that absence without anyone noticing. They passed because
      // invitation links were built from the REQUEST origin -- which is the
      // defect fixed alongside this: behind nginx that origin is the container
      // id, so real invitation emails carried a link to a host that exists only
      // inside the Docker network. `lib/publicOrigin.ts` now throws rather than
      // guessing, so the tests must supply what production supplies.
      //
      // A recognisable, obviously-fake origin: an assertion that accidentally
      // matches it should read as a test artefact, not as a real domain.
      NEXTAUTH_URL: 'https://vitest.example.invalid',
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
