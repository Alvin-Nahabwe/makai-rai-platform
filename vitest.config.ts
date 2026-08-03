import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    globals: true,
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
    },
  },
  resolve: { alias: { '@': path.resolve(__dirname, '.') } },
});
