/**
 * Digests that make one leak-check run replayable by a third party.
 *
 * The OKF `attestation:` block names the computation, the digest of the attester
 * source that produced the verdict, and the digests of the two masked artifacts
 * the gateway serves. A reader can fetch all three and re-derive the verdict
 * without trusting this fleet — which is the whole point of an Attested
 * Computation (SPEC §10).
 *
 * The digests are **fixed at build time** and imported as constants from
 * `attestation_digests.generated.ts`. Why not hash at runtime only: the
 * production Synthesis image ships `dist/` alone, so neither the attester `.ts`
 * source nor `knowledge/` is present in the container, and the old on-disk hash
 * degraded to the literal string `unavailable` while the document still claimed
 * machine confirmation. A constant compiled into `dist/` has the same value in a
 * checkout and in the image.
 *
 * When the sources *are* on disk — a checkout, a test run, the build stage — the
 * runtime hash is still computed and compared against the constant, so a stale
 * generated file is a loud failure rather than a silently wrong digest.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTESTER_SHA256_BUILD,
  COMPUTATION_SHA256_BUILD,
} from './attestation_digests.generated.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Bundle path of the Attested Computation this fleet runs. */
export const COMPUTATION_RESOURCE = '/computations/leak-check.md';

/** Where the attester lives inside the knowledge bundle (SPEC §6.2). */
export const ATTESTER_RESOURCE = '/references/attesters/leak_check.ts';

/**
 * A digest is a lowercase SHA-256 hex string and nothing else.
 *
 * The schema enforces the same shape on the wire; this is the producer side of
 * that contract, so a malformed constant cannot reach a document at all.
 */
export const SHA256_HEX = /^[0-9a-f]{64}$/u;

/** True when `value` is a syntactically valid SHA-256 digest. */
export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && SHA256_HEX.test(value);
}

/**
 * Files whose bytes back the two resources above.
 *
 * Resolved relative to this module rather than to the working directory: a Cloud
 * Run container starts wherever the entrypoint says. Only used for the
 * consistency assertion below; the served digest always comes from the constant.
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

/** Digest of the first candidate that exists, or `null` when none do. */
function digestOnDisk(candidates: readonly string[]): string | null {
  for (const candidate of candidates) {
    try {
      return createHash('sha256').update(readFileSync(candidate)).digest('hex');
    } catch {
      // Try the next layout; a packaged build and a checkout differ.
    }
  }
  return null;
}

/** Raised when a build-time digest disagrees with the bytes on disk. */
export class AttestationDigestMismatchError extends Error {
  readonly resource: string;

  constructor(resource: string, expected: string, actual: string) {
    super(
      `attestation digest for ${resource} is stale: the build recorded ${expected} but the ` +
        `source on disk hashes to ${actual}; rebuild @privacy-gateway/common`,
    );
    this.name = 'AttestationDigestMismatchError';
    this.resource = resource;
  }
}

/**
 * Return the constant, asserting it against the on-disk bytes when they exist.
 *
 * @throws {AttestationDigestMismatchError} when the two disagree — a stale
 *   generated file must never quietly serve the wrong digest.
 */
function resolveDigest(resource: string, constant: string, candidates: readonly string[]): string {
  if (!isSha256Hex(constant)) {
    throw new AttestationDigestMismatchError(resource, constant, '(not a sha256 digest)');
  }
  const onDisk = digestOnDisk(candidates);
  if (onDisk !== null && onDisk !== constant) {
    throw new AttestationDigestMismatchError(resource, constant, onDisk);
  }
  return constant;
}

let attesterDigest: string | undefined;
let computationDigest: string | undefined;

/** SHA-256 of the attester source, as named by `attestation.attester_sha256`. */
export function attesterSha256(): string {
  attesterDigest ??= resolveDigest(ATTESTER_RESOURCE, ATTESTER_SHA256_BUILD, ATTESTER_CANDIDATES);
  return attesterDigest;
}

/** SHA-256 of the Attested Computation document. */
export function computationSha256(): string {
  computationDigest ??= resolveDigest(
    COMPUTATION_RESOURCE,
    COMPUTATION_SHA256_BUILD,
    COMPUTATION_CANDIDATES,
  );
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
