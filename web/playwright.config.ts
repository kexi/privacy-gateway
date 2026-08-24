/**
 * Browser tests for the demo UI.
 *
 * The webServer boots the real Gateway and Synthesis against an in-memory vault
 * with only Core and Gemma mocked, so what the browser drives is the production
 * request path rather than a stubbed API.
 *
 * Chromium only: these assert application behaviour, not rendering differences,
 * and a second engine would double the runtime for no extra signal.
 *
 * Browsers come from the Nix devShell via PLAYWRIGHT_BROWSERS_PATH; nothing here
 * shells out to `playwright install`. Outside Nix, run
 * `pnpm -C web exec playwright install chromium` once.
 */

import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['E2E_GATEWAY_PORT'] ?? 8181);
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: process.env['CI'] ? 1 : 0,
  // One worker: the fleet keeps a single in-memory vault, and parallel workers
  // would race on session state.
  workers: 1,
  reporter: process.env['CI'] ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Why not the default headless shell: the Nix playwright-driver bundle
        // ships only `chromium-<rev>` (the full browser), not
        // `chromium_headless_shell-<rev>`, which Playwright >= 1.49 launches by
        // default for the `chromium` browser. Selecting the `chromium` channel
        // points it at the binary Nix actually provides.
        channel: 'chromium',
        // The clipboard specs read navigator.clipboard, which is gated on a
        // secure context and on the permission being granted per context.
        permissions: ['clipboard-read', 'clipboard-write'],
      },
    },
  ],

  webServer: {
    // The UI is served by the gateway itself, exactly as in production, so the
    // build must exist before the server starts.
    command: 'pnpm build && pnpm exec tsx e2e/fleet-server.ts',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env['CI'],
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
