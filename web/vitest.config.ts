/**
 * Unit tests for the UI's pure logic.
 *
 * Playwright still owns anything that needs a browser; this config exists for
 * the parts that do not — chiefly the alignment that recovers which substrings
 * were masked, which is a string function and deserves to be tested as one
 * rather than through a rendered page.
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  // `development` makes @privacy-gateway/common resolve to its TypeScript
  // sources, so a test exercises the working tree rather than a stale dist/.
  resolve: { conditions: ['development', 'import', 'node', 'default'] },
  test: {
    environment: 'node',
    // `e2e/` is Playwright's; vitest must not try to run those specs.
    include: ['test/**/*.test.ts'],
  },
});
