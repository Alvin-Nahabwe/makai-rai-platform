import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    globals: true,
    /**
     * Disable file-level parallelism. Integration tests share one Postgres
     * database and call resetDb() (which issues TRUNCATE...RESTART IDENTITY
     * CASCADE) between test suites. When test files run in parallel, one file's
     * truncate deletes rows the other file just created, causing flaky failures
     * (Foreign key constraint violated). Serializing file execution is the
     * simplest fix: all tests run in ~1s anyway, so the performance cost is
     * negligible and the determinism gain is critical.
     */
    fileParallelism: false,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://makrai:makrai_dev_password@localhost:5432/makrai_test',
      // Populated in Task 3; harmless until then.
      APP_DATABASE_URL:
        process.env.TEST_APP_DATABASE_URL ??
        'postgresql://makrai_app:app_dev_password@localhost:5432/makrai_test',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
