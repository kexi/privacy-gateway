/**
 * What the *built* Synthesis output guarantees.
 *
 * Every other test in this suite runs against `src/`, where the attester source
 * and the knowledge bundle are both on disk. The production image ships only
 * `dist/`, and that is precisely the environment where the old on-disk hash
 * degraded to the literal string `unavailable` while the document still claimed
 * machine confirmation. So this test builds the workspace and runs the compiled
 * JavaScript with `node`, which is what the container actually executes.
 *
 * `just image-test` is the container-level version of the same check.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const commonDist = path.join(repoRoot, 'packages/common/dist/index.js');

/** Build only what this test reads, so it does not depend on suite ordering. */
beforeAll(() => {
  if (existsSync(commonDist)) return;
  execFileSync('pnpm', ['--filter', '@privacy-gateway/common', 'build'], {
    cwd: repoRoot,
    stdio: 'pipe',
  });
}, 180_000);

/** Runs one expression against the built bundle and returns its JSON result. */
function inDist(expression: string): unknown {
  const script = `
    const m = await import(${JSON.stringify(commonDist)});
    process.stdout.write(JSON.stringify(${expression}));
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return JSON.parse(output) as unknown;
}

describe('the built output carries real digests', () => {
  it('reports a valid attester digest from dist, not `unavailable`', () => {
    expect(inDist('m.attesterSha256()')).toMatch(/^[0-9a-f]{64}$/u);
  }, 60_000);

  it('reports a valid computation digest from dist', () => {
    expect(inDist('m.computationSha256()')).toMatch(/^[0-9a-f]{64}$/u);
  }, 60_000);

  it('builds a machine-confirmable document from dist', () => {
    // The end-to-end property: a build whose digests are unusable produces a
    // draft, so a stable document out of `dist/` is proof the packaging is
    // sound.
    const status = inDist(`
      m.buildGatewayAnswer({
        requestId: '01920000-0000-7000-8000-000000000001',
        maskedAnswerBody: 'ok',
        coreActor: 'core_agent/gemini-3.5-flash',
        generatedBy: 'synthesis_agent/0.1.0',
        verifiedBy: m.leakCheckActor(),
        staleAfter: new Date(Date.now() + 3600000),
        attestation: { ok: true, reason: null, findings: [] },
        evidence: {
          computation: m.COMPUTATION_RESOURCE,
          computationSha256: m.computationSha256(),
          attesterSha256: m.attesterSha256(),
          maskedPromptSha256: '0'.repeat(64),
          coreResponseSha256: 'f'.repeat(64),
          checkedAt: new Date(),
        },
      }).metadata.status
    `);

    expect(status).toBe('stable');
  }, 60_000);
});
