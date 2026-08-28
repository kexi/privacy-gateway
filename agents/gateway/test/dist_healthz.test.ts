/**
 * What the *built* Gateway server serves on its liveness routes.
 *
 * Every other gateway test drives `createApp` from `src/`, where a route can be
 * asserted without ever starting a listener. This one boots the compiled
 * `dist/server.js` with `node` — what the container actually runs — because the
 * defect that motivated it was invisible to a source-level test: the deployed
 * service answered `GET /healthz` with `404` while `GET /v1/models` answered
 * `200` on the same revision.
 *
 * The investigation (docs/proof/openai-compat.md, "healthz") established that
 * the application is not at fault. On `*.run.app` the exact path `/healthz` is
 * intercepted upstream of the container — the 404 is a Google Front End HTML
 * page carrying none of Express's headers, and it is returned even on an
 * IAM-closed service that answers `403` for every other path. So the guarantee
 * worth pinning is a property of *this* code: the built server binds `/healthz`
 * and answers it. A regression here means the route was lost in packaging,
 * which is the one failure the deployment could not distinguish from the
 * platform's interception.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const gatewayDist = path.join(repoRoot, 'agents/gateway/dist/server.js');

/** A high port, so a developer's running `just dev` gateway is not disturbed. */
const PORT = 18099;
const BASE = `http://127.0.0.1:${PORT}`;

let server: ReturnType<typeof spawn> | undefined;

/** Build only what this test runs, so it does not depend on suite ordering. */
beforeAll(async () => {
  if (!existsSync(gatewayDist)) {
    execFileSync('pnpm', ['--filter', '@privacy-gateway/gateway...', 'build'], {
      cwd: repoRoot,
      stdio: 'pipe',
    });
  }

  server = spawn(process.execPath, [gatewayDist], {
    cwd: path.join(repoRoot, 'agents/gateway'),
    env: {
      ...process.env,
      PORT: String(PORT),
      // In-memory vault: this test asserts routing, and a Firestore client
      // would make it depend on credentials it has no reason to need.
      VAULT_BACKEND: 'memory',
      // Absent, so `mountWebUi` takes its no-web-build branch. The route under
      // test is registered before that mount either way, and pinning the branch
      // keeps the result independent of whether `web/dist` happens to exist.
      WEB_DIR: path.join(repoRoot, 'agents/gateway/dist/__no_web_ui__'),
    },
    stdio: 'pipe',
  });

  // Poll rather than sleep: a fixed wait is either flaky or slow.
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${BASE}/healthz`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error('the built gateway server did not start');
}, 180_000);

afterAll(() => {
  server?.kill();
});

describe('the built gateway server answers its liveness route', () => {
  it('serves GET /healthz with 200 and the agent name', async () => {
    const response = await fetch(`${BASE}/healthz`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', agent: 'gateway' });
  });

  it('serves GET /v1/models, so a healthz failure could not be mistaken for a dead server', async () => {
    // The deployed symptom was these two disagreeing. Asserting both together
    // is what makes a future regression legible: if `/healthz` breaks while
    // this still passes, the cause is the route, not the process.
    expect((await fetch(`${BASE}/v1/models`)).status).toBe(200);
  });

  it('still answers 404 through Express for a route it does not define', async () => {
    // Guards the inverse reading of the evidence: a 404 that carries Express's
    // header came from this app, whereas the deployed `/healthz` 404 carried
    // none and therefore never reached it.
    const response = await fetch(`${BASE}/definitely-not-a-route`);

    expect(response.status).toBe(404);
    expect(response.headers.get('x-powered-by')).toBe('Express');
  });
});
