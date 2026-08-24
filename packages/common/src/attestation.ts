/**
 * Digests that make one leak-check run replayable by a third party.
 *
 * The OKF `attestation:` block names the computation, the digest of the attester
 * source that produced the verdict, and the digests of the two masked artifacts
 * the gateway serves. A reader can fetch all three and re-derive the verdict
 * without trusting this fleet — which is the whole point of an Attested
 * Computation (SPEC §10).
 *
 * The digests are read from disk once and cached: they are properties of the
 * deployed build, not of a request.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Bundle path of the Attested Computation this fleet runs. */
export const COMPUTATION_RESOURCE = '/computations/leak-check.md';

/** Where the attester lives inside the knowledge bundle (SPEC §6.2). */
export const ATTESTER_RESOURCE = '/references/attesters/leak_check.ts';

/**
 * Files whose bytes back the two resources above.
 *
 * Resolved relative to this module rather than to the working directory: a Cloud
 * Run container starts wherever the entrypoint says, and a digest that silently
 * became `unavailable` because of a `cwd` difference would be worse than none.
 */
const ATTESTER_CANDIDATES = [
  path.resolve(here, './attesters/leak_check.ts'),
  path.resolve(here, '../src/attesters/leak_check.ts'),
  path.resolve(here, '../../../knowledge/references/attesters/leak_check.ts'),
  path.resolve(here, '../../../../knowledge/references/attesters/leak_check.ts'),
];

const COMPUTATION_CANDIDATES = [
  path.resolve(here, '../../../knowledge/computations/leak-check.md'),
  path.resolve(here, '../../../../knowledge/computations/leak-check.md'),
];

/** Digest of the first candidate that exists, or `unavailable`. */
function digestOf(candidates: readonly string[]): string {
  for (const candidate of candidates) {
    try {
      return createHash('sha256').update(readFileSync(candidate)).digest('hex');
    } catch {
      // Try the next layout; a packaged build and a checkout differ.
    }
  }
  // Why not throw: a missing digest degrades the evidence, but refusing to
  // answer over it would turn a packaging detail into an outage.
  return 'unavailable';
}

let attesterDigest: string | undefined;
let computationDigest: string | undefined;

/** SHA-256 of the attester source, as named by `attestation.attester_sha256`. */
export function attesterSha256(): string {
  attesterDigest ??= digestOf(ATTESTER_CANDIDATES);
  return attesterDigest;
}

/** SHA-256 of the Attested Computation document. */
export function computationSha256(): string {
  computationDigest ??= digestOf(COMPUTATION_CANDIDATES);
  return computationDigest;
}

/**
 * The OKF actor for the process that decided the verdict (SPEC §7).
 *
 * TypeScript regex code decides pass or fail, so the actor is a `process:`, not
 * the Gemma-backed `synthesis_agent/...` — Gemma only ever advises here.
 */
export function leakCheckActor(digest: string = attesterSha256()): string {
  return `process:leak-check@${digest.slice(0, 12)}`;
}

/** Reset the cached digests. Test-only. */
export function resetAttestationDigestsForTests(): void {
  attesterDigest = undefined;
  computationDigest = undefined;
}
