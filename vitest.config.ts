/**
 * Root test configuration.
 *
 * `projects` lets one `pnpm vitest run` at the repository root drive every
 * package, while each package keeps its own config so `pnpm --filter X test`
 * still works on its own. The vitest version is pinned once here so a project
 * cannot silently run a different runner than the rest.
 */

import { defineConfig } from 'vitest/config';

/**
 * Coverage floors.
 *
 * Branches sit lower than lines everywhere: much of the branching here is
 * defensive — malformed Firestore values, absent optional fields, unreachable
 * `?? fallback` arms — and driving those to the line figure would mean writing
 * tests that assert nothing a caller can observe.
 */
const COMMON_THRESHOLD = 90;
const COMMON_BRANCH_THRESHOLD = 80;
const AGENT_THRESHOLD = 70;
const AGENT_BRANCH_THRESHOLD = 65;

export default defineConfig({
  test: {
    projects: [
      'packages/common',
      'agents/core',
      'agents/gateway',
      'agents/synthesis',
      'services/kill-switch',
      'clients/mcp',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      include: [
        'packages/*/src/**/*.ts',
        'agents/*/src/**/*.ts',
        'services/*/src/**/*.ts',
        'clients/mcp/src/**/*.ts',
      ],
      exclude: ['**/dist/**', '**/*.d.ts', '**/*.config.ts'],
      // packages/common holds the masking, vault and OKF logic the guarantees
      // rest on, so it carries the stricter floor; the agents are thinner
      // orchestration over it.
      thresholds: {
        lines: AGENT_THRESHOLD,
        functions: AGENT_THRESHOLD,
        branches: AGENT_BRANCH_THRESHOLD,
        statements: AGENT_THRESHOLD,
        'packages/common/src/**/*.ts': {
          lines: COMMON_THRESHOLD,
          functions: COMMON_THRESHOLD,
          branches: COMMON_BRANCH_THRESHOLD,
          statements: COMMON_THRESHOLD,
        },
      },
    },
  },
});
