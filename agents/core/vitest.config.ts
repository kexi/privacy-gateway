import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `development` makes the workspace package resolve to its TypeScript sources,
  // so a test exercises the working tree rather than a stale dist/.
  resolve: { conditions: ['development', 'import', 'node', 'default'] },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 20_000,
  },
});
