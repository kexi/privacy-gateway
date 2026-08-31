/**
 * Records deterministic 1080p submission demos.
 *
 * The browser path boots the same Gateway and Synthesis implementations used in
 * production. Core and Gemma stay at the existing E2E fetch seam so a recording
 * does not depend on GPU temperature or spend cloud budget.
 */

import { defineConfig } from '@playwright/test';

const GATEWAY_PORT = 8281;
const SYNTHESIS_PORT = 8283;

export default defineConfig({
  testDir: './demo',
  testMatch: '**/*.demo.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 180_000,
  reporter: [['list']],
  outputDir: './test-results/demo',

  use: {
    baseURL: `http://127.0.0.1:${GATEWAY_PORT}`,
    // The Nix Playwright bundle ships full Chromium, not headless shell.
    channel: 'chromium',
    viewport: { width: 1920, height: 1080 },
    colorScheme: 'dark',
    video: {
      mode: 'on',
      size: { width: 1920, height: 1080 },
    },
  },

  webServer: {
    command: 'just web-build && pnpm exec tsx e2e/fleet-server.ts',
    env: {
      E2E_GATEWAY_PORT: String(GATEWAY_PORT),
      E2E_SYNTHESIS_PORT: String(SYNTHESIS_PORT),
    },
    url: `http://127.0.0.1:${GATEWAY_PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
