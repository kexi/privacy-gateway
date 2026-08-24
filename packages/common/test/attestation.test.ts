/**
 * What the attestation digests guarantee: a document never claims machine
 * confirmation over a digest a third party cannot fetch.
 *
 * The production Synthesis image ships only `dist/`, so the old on-disk hash of
 * a `.ts` source degraded to the literal string `unavailable` inside the
 * container — while `verified` was still written and the trust tier still read
 * `machine-confirmed`. These tests pin both halves of the fix: the digest is a
 * build-time constant, and an unusable one drops the document to draft.
 */

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ATTESTER_RESOURCE,
  attesterSha256,
  COMPUTATION_RESOURCE,
  computationSha256,
  isSha256Hex,
  leakCheckActor,
} from '../src/attestation.ts';
import { buildGatewayAnswer, trustTier, TRUST_UNVERIFIED } from '../src/okf.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const repoRoot = path.resolve(packageRoot, '../..');

function digestOf(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('the digests are usable', () => {
  it('reports 64 lowercase hex characters, never the string unavailable', () => {
    expect(attesterSha256()).toMatch(/^[0-9a-f]{64}$/u);
    expect(computationSha256()).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('matches the bytes of the files the resources name', () => {
    expect(attesterSha256()).toBe(digestOf(path.join(packageRoot, 'src/attesters/leak_check.ts')));
    expect(computationSha256()).toBe(
      digestOf(path.join(repoRoot, 'knowledge/computations/leak-check.md')),
    );
  });

  it('names the resources a reader must fetch to replay the verdict', () => {
    expect(ATTESTER_RESOURCE).toBe('/references/attesters/leak_check.ts');
    expect(COMPUTATION_RESOURCE).toBe('/computations/leak-check.md');
  });

  it('builds a process actor from the real digest, not a placeholder', () => {
    expect(leakCheckActor()).toMatch(/^process:leak-check@[0-9a-f]{12}$/u);
  });

  it('recognises a digest by syntax rather than by length alone', () => {
    expect(isSha256Hex('a'.repeat(64))).toBe(true);
    expect(isSha256Hex('unavailable')).toBe(false);
    expect(isSha256Hex('A'.repeat(64))).toBe(false);
    expect(isSha256Hex('z'.repeat(64))).toBe(false);
  });
});

describe('the generated constants stay in sync with their sources', () => {
  it('passes the build-time --check', () => {
    // The same check the build runs. A generated file that has drifted from the
    // attester it names would ship a digest pointing at bytes nobody has.
    expect(() =>
      execFileSync(
        process.execPath,
        [path.join(packageRoot, 'scripts/generate_attestation_digests.mjs'), '--check'],
        { stdio: 'pipe' },
      ),
    ).not.toThrow();
  });
});

describe('an unusable digest cannot be machine-confirmed', () => {
  const base = {
    requestId: '01920000-0000-7000-8000-000000000001',
    maskedAnswerBody: 'Reply to ⟦PERSON_1⟧.',
    coreActor: 'core_agent/gemini-3.5-flash',
    generatedBy: 'synthesis_agent/0.1.0',
    verifiedBy: 'process:leak-check@abcdef012345',
    staleAfter: new Date(Date.now() + 3_600_000),
    attestation: { ok: true, reason: null, findings: [] },
  };

  function withDigests(overrides: Record<string, string>) {
    return buildGatewayAnswer({
      ...base,
      evidence: {
        computation: COMPUTATION_RESOURCE,
        computationSha256: 'c'.repeat(64),
        attesterSha256: 'a'.repeat(64),
        maskedPromptSha256: '0'.repeat(64),
        coreResponseSha256: 'f'.repeat(64),
        checkedAt: new Date(),
        ...overrides,
      },
    });
  }

  it('marks the document draft when the attester digest is unavailable', () => {
    // This is exactly what a `dist`-only image used to emit while still writing
    // `verified` and reading back as machine-confirmed.
    const document = withDigests({ attesterSha256: 'unavailable' });

    expect(document.metadata['status']).toBe('draft');
    expect(document.metadata['verified']).toBeUndefined();
    expect(trustTier(document.metadata)).toBe(TRUST_UNVERIFIED);
  });

  it('marks the document draft when the computation digest is unavailable', () => {
    const document = withDigests({ computationSha256: 'unavailable' });
    expect(trustTier(document.metadata)).toBe(TRUST_UNVERIFIED);
  });

  it('says why in the attestation section rather than dropping the failure', () => {
    // OKF SPEC §10.5: a failed attestation must be surfaced, never silently
    // omitted.
    const document = withDigests({ attesterSha256: 'unavailable' });
    expect(document.content).toContain('no usable attestation digests');
  });

  it('still machine-confirms when every digest is well formed', () => {
    const document = withDigests({});
    expect(document.metadata['status']).toBe('stable');
    expect(trustTier(document.metadata)).toBe('machine-confirmed');
  });
});
