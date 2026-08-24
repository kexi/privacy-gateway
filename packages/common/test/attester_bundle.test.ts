/**
 * What binds the OKF bundle's attester to the one that actually runs.
 *
 * `knowledge/computations/leak-check.md` declares
 * `attester.resource: /references/attesters/leak_check.ts`, and a judge who
 * follows that link must get the same bytes Synthesis imports. Nothing enforces
 * that at build time, so it is enforced here: a change to one file without the
 * other fails this test rather than shipping a bundle whose sanctioned attester
 * differs from the deployed one.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { attesterSha256, computationSha256, leakCheckActor } from '../src/attestation.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE = path.resolve(here, '../src/attesters/leak_check.ts');
const BUNDLE = path.resolve(here, '../../../knowledge/references/attesters/leak_check.ts');

function digest(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('bundle / workspace attester identity', () => {
  it('serves byte-identical attester source from both locations', () => {
    expect(digest(BUNDLE)).toBe(digest(WORKSPACE));
  });

  it('reports the digest of the file that actually decides verdicts', () => {
    expect(attesterSha256()).toBe(digest(WORKSPACE));
  });

  it('resolves the computation digest from the bundle', () => {
    expect(computationSha256()).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe('the verifier actor (SPEC §7)', () => {
  it('names a process, never an LLM', () => {
    // TypeScript regex code decides pass or fail; attributing it to a Gemma
    // model would misstate who verified what.
    expect(leakCheckActor()).toMatch(/^process:leak-check@[0-9a-f]{12}$/u);
  });

  it('embeds the attester digest so the actor identifies the code', () => {
    expect(leakCheckActor()).toContain(attesterSha256().slice(0, 12));
  });
});
