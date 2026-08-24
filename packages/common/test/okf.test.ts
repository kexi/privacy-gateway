/** What OKF v0.2 parsing, assembly and trust signal derivation guarantee. */

import { describe, expect, it } from 'vitest';
import {
  addVerification,
  buildGatewayAnswer,
  dump,
  freshness,
  GATEWAY_ANSWER_TYPE,
  isStale,
  nowIso,
  parse,
  REQUEST_ARTIFACT_BASE,
  TRUST_HUMAN_REVIEWED,
  TRUST_MACHINE_CONFIRMED,
  TRUST_UNVERIFIED,
  trustTier,
  type AttestationEvidence,
  type AttestationLike,
} from '../src/okf.ts';

const REQUEST_ID = '01920000-0000-7000-8000-000000000001';

const EVIDENCE: AttestationEvidence = {
  computation: '/computations/leak-check.md',
  // Hex on purpose: a digest that is not 64 lowercase hex characters names
  // bytes nobody can fetch, and the builder refuses to machine-confirm over one.
  computationSha256: 'c'.repeat(64),
  attesterSha256: 'a'.repeat(64),
  maskedPromptSha256: '0'.repeat(64),
  coreResponseSha256: 'f'.repeat(64),
  checkedAt: new Date('2026-08-24T10:00:00Z'),
};

const PASSING_ATTESTATION: AttestationLike = { ok: true, reason: null, findings: [] };
const FAILING_ATTESTATION: AttestationLike = {
  ok: false,
  reason: 'raw PII detected',
  findings: ['EMAIL'],
};

/** One hour ahead, matching a live vault entry. */
function staleAfter(): Date {
  return new Date(Date.now() + 3600 * 1000);
}

function answer(attestation: AttestationLike = PASSING_ATTESTATION) {
  return buildGatewayAnswer({
    requestId: REQUEST_ID,
    maskedAnswerBody: 'Here is the reply about ⟦PERSON_1⟧.',
    coreActor: 'core_agent/gemini-3.5-flash',
    generatedBy: 'synthesis_agent/0.1.0',
    verifiedBy: 'process:leak-check@aaaaaaaaaaaa',
    staleAfter: staleAfter(),
    attestation,
    evidence: EVIDENCE,
  });
}

describe('trust tier (SPEC §5.3)', () => {
  it('treats a concept without verified as unverified', () => {
    expect(trustTier({ type: 'Gateway Answer' })).toBe(TRUST_UNVERIFIED);
  });

  it('treats machine-only verification as machine-confirmed', () => {
    expect(trustTier({ verified: [{ by: 'synthesis_agent/gemma-3', at: nowIso() }] })).toBe(
      TRUST_MACHINE_CONFIRMED,
    );
  });

  it('raises the tier to human-reviewed for a human verifier', () => {
    const metadata = {
      verified: [
        { by: 'synthesis_agent/gemma-3', at: nowIso() },
        { by: 'human:kei', at: nowIso() },
      ],
    };
    expect(trustTier(metadata)).toBe(TRUST_HUMAN_REVIEWED);
  });

  it('counts a bare verified mapping as one entry', () => {
    // SPEC §5.2: a consumer must treat a bare mapping as a one-element list.
    expect(trustTier({ verified: { by: 'human:kei', at: nowIso() } })).toBe(TRUST_HUMAN_REVIEWED);
  });

  it('does not count a process actor as human', () => {
    expect(trustTier({ verified: [{ by: 'process:nightly', at: nowIso() }] })).toBe(
      TRUST_MACHINE_CONFIRMED,
    );
  });

  it('treats an empty verified list as unverified', () => {
    expect(trustTier({ verified: [] })).toBe(TRUST_UNVERIFIED);
  });

  it('does not let an entry without an actor claim machine confirmation', () => {
    // A `verified` entry naming nobody verified nothing; counting it would let
    // `verified: [{}]` manufacture a trust tier.
    expect(trustTier({ verified: [{}] })).toBe(TRUST_UNVERIFIED);
    expect(trustTier({ verified: [{ at: nowIso() }] })).toBe(TRUST_UNVERIFIED);
    expect(trustTier({ verified: [{ by: '   ' }] })).toBe(TRUST_UNVERIFIED);
  });

  it('ignores malformed entries but still counts the well-formed ones', () => {
    // §11: the malformed value is preserved in the document; it just does not vote.
    expect(trustTier({ verified: [{}, { by: 'process:leak-check@abc' }] })).toBe(
      TRUST_MACHINE_CONFIRMED,
    );
  });

  it('does not reject a document that carries a malformed verified field', () => {
    const source = '---\ntype: Gateway Answer\nverified: "not a mapping"\n---\n\nBody.\n';
    const document = parse(source);
    expect(document.metadata['verified']).toBe('not a mapping');
    expect(trustTier(document.metadata)).toBe(TRUST_UNVERIFIED);
  });
});

describe('staleness (SPEC §5.5)', () => {
  it('is stale once stale_after has passed', () => {
    expect(isStale({ stale_after: nowIso(new Date(Date.now() - 3600 * 1000)) })).toBe(true);
  });

  it('is fresh with a future stale_after', () => {
    expect(isStale({ stale_after: nowIso(new Date(Date.now() + 3600 * 1000)) })).toBe(false);
  });

  it('reports unknown freshness without stale_after', () => {
    expect(freshness({ type: 'Policy' })).toBe('unknown');
  });

  it('reports unknown freshness for an unparseable stale_after', () => {
    // §11: the document is still readable, but a value that cannot be read must
    // not be reported as fresh.
    expect(freshness({ stale_after: 'sometime next week' })).toBe('unknown');
  });

  it('distinguishes fresh from stale from unknown', () => {
    expect(freshness({ stale_after: nowIso(new Date(Date.now() + 3600_000)) })).toBe('fresh');
    expect(freshness({ stale_after: nowIso(new Date(Date.now() - 3600_000)) })).toBe('stale');
    expect(freshness({})).toBe('unknown');
  });

  it('treats unknown freshness as stale for the yes/no question', () => {
    // isStale fails closed: a caller that only asks "may I use this" gets no.
    expect(isStale({ type: 'Policy' })).toBe(true);
    expect(isStale({ stale_after: 'sometime next week' })).toBe(true);
  });
});

describe('round-trip (SPEC §11)', () => {
  it('preserves unknown keys and unknown types', () => {
    const source = [
      '---',
      'type: Totally Unknown Type',
      'title: Example',
      'custom_vendor_key: {nested: [1, 2]}',
      '---',
      '',
      'Body text.',
      '',
    ].join('\n');

    const document = parse(source);
    expect(document.metadata['type']).toBe('Totally Unknown Type');
    expect(document.metadata['custom_vendor_key']).toEqual({ nested: [1, 2] });

    const reparsed = parse(dump(document));
    expect(reparsed.metadata).toEqual(document.metadata);
    expect(reparsed.content.trim()).toBe('Body text.');
  });

  it('still reads a document without frontmatter', () => {
    const document = parse('# Just a heading\n');
    expect(document.metadata).toEqual({});
    expect(document.content).toContain('Just a heading');
  });

  it('does not throw on broken YAML', () => {
    expect(parse('---\nkey: [unclosed\n---\n\nbody\n').metadata).toEqual({});
  });

  it('preserves the body through dump then parse', () => {
    const document = { metadata: { type: 'Policy' }, content: '# Heading\n\nText.' };
    expect(parse(dump(document)).content.trim()).toBe('# Heading\n\nText.');
  });
});

describe('Gateway Answer assembly', () => {
  it('marks a passing answer stable and machine-confirmed', () => {
    const document = answer();
    expect(document.metadata['type']).toBe(GATEWAY_ANSWER_TYPE);
    expect(document.metadata['status']).toBe('stable');
    expect(trustTier(document.metadata)).toBe(TRUST_MACHINE_CONFIRMED);
  });

  it('attributes generation to the agent that assembled the document', () => {
    // Core supplies tokenized prose; Synthesis assembles the concept, and §7
    // attributes a document to whoever wrote it.
    expect((answer().metadata['generated'] as { by: string }).by).toBe('synthesis_agent/0.1.0');
  });

  it('attributes the core invocation as provenance, not as the generator', () => {
    const sources = answer().metadata['sources'] as Array<{ id: string; author?: string }>;
    const core = sources.find((source) => source.id === 'core-response');
    expect(core?.author).toBe('core_agent/gemini-3.5-flash');
  });

  it('names a process actor as the verifier, never an LLM', () => {
    // TypeScript regex code decides the verdict; Gemma only advises.
    const verified = answer().metadata['verified'] as Array<{ by: string }>;
    expect(verified[0]?.by).toMatch(/^process:leak-check@/u);
  });

  it('carries a replayable attestation block', () => {
    const block = answer().metadata['attestation'] as Record<string, unknown>;
    expect(block['computation']).toBe('/computations/leak-check.md');
    expect(block['computation_sha256']).toBe(EVIDENCE.computationSha256);
    expect(block['attester_sha256']).toBe(EVIDENCE.attesterSha256);
    expect(block['masked_prompt_sha256']).toBe(EVIDENCE.maskedPromptSha256);
    expect(block['core_response_sha256']).toBe(EVIDENCE.coreResponseSha256);
    expect(block['verdict']).toBe('pass');
    expect(block['checked_at']).toBe('2026-08-24T10:00:00Z');
    expect(block['request_id']).toBe(REQUEST_ID);
  });

  it('records a fail verdict in the attestation block when the check failed', () => {
    const block = answer(FAILING_ATTESTATION).metadata['attestation'] as Record<string, unknown>;
    expect(block['verdict']).toBe('fail');
  });

  it('stores only the masked answer body', () => {
    // The rehydrated form is returned to the caller and never persisted.
    const document = answer();
    expect(document.content).toContain('⟦PERSON_1⟧');
    expect(document.content).toContain('not stored');
  });

  it('lists withheld categories when the disclosure policy kept some masked', () => {
    const document = buildGatewayAnswer({
      requestId: REQUEST_ID,
      maskedAnswerBody: 'Key ⟦API_KEY_1⟧ was used.',
      coreActor: 'core_agent/gemini-3.5-flash',
      generatedBy: 'synthesis_agent/0.1.0',
      verifiedBy: 'process:leak-check@aaaaaaaaaaaa',
      staleAfter: staleAfter(),
      attestation: PASSING_ATTESTATION,
      evidence: { ...EVIDENCE, withheld: ['API_KEY'] },
    });
    const block = document.metadata['attestation'] as { withheld?: string[] };
    expect(block.withheld).toEqual(['API_KEY']);
    expect(document.content).toContain('API_KEY');
  });

  it('never uses the word signed', () => {
    // There is no signature and no MAC; claiming one would be a false assurance.
    expect(dump(answer()).toLowerCase()).not.toContain('signed');
  });

  it('makes a failing attestation a draft', () => {
    const document = answer(FAILING_ATTESTATION);
    expect(document.metadata['status']).toBe('draft');
    // verified is omitted on failure, so the tier drops to unverified.
    expect(trustTier(document.metadata)).toBe(TRUST_UNVERIFIED);
  });

  it('surfaces a failing attestation in the body', () => {
    // SPEC §10.5: a failed attestation must not be silently dropped.
    const document = answer(FAILING_ATTESTATION);
    expect(document.content).toContain('# Attestation');
    expect(document.content).toContain('failed');
    expect(document.content).toContain('raw PII detected');
    expect(document.content).toContain('EMAIL');
  });

  it('cites both masked artifacts and the policy, at paths the gateway serves', () => {
    const sources = answer().metadata['sources'] as Array<{ resource: string }>;
    const resources = sources.map((source) => source.resource);
    // The gateway serves these under /v1; a source that omits the prefix is a
    // dangling link and makes the document unreplayable.
    expect(resources).toContain(`${REQUEST_ARTIFACT_BASE}/${REQUEST_ID}/masked-prompt.md`);
    expect(resources).toContain(`${REQUEST_ARTIFACT_BASE}/${REQUEST_ID}/core-response.md`);
    expect(REQUEST_ARTIFACT_BASE).toBe('/v1/requests');
    expect(resources).toContain('/policies/pii-masking.md');
  });

  it('mirrors the vault expiry in stale_after', () => {
    const expiry = staleAfter();
    const document = buildGatewayAnswer({
      requestId: REQUEST_ID,
      maskedAnswerBody: 'Reply.',
      coreActor: 'core_agent/gemini-3.5-flash',
      generatedBy: 'synthesis_agent/0.1.0',
      verifiedBy: 'process:leak-check@aaaaaaaaaaaa',
      staleAfter: expiry,
      attestation: PASSING_ATTESTATION,
      evidence: EVIDENCE,
    });
    expect(document.metadata['stale_after']).toBe(nowIso(expiry));
  });

  it('the library can still add a human verifier, though the product never does', () => {
    // The derivation stays generic: OKF is a general format and other consumers
    // do have authenticated reviewers. This fleet simply never mints a human:
    // actor, because it authenticates nobody.
    const document = answer();
    expect(trustTier(document.metadata)).toBe(TRUST_MACHINE_CONFIRMED);

    addVerification(document, 'human:kei');
    expect(trustTier(document.metadata)).toBe(TRUST_HUMAN_REVIEWED);
    expect(document.metadata['verified']).toHaveLength(2);
  });

  it('stores the correlation ids as top-level extension keys', () => {
    const document = buildGatewayAnswer({
      requestId: REQUEST_ID,
      maskedAnswerBody: 'Reply.',
      coreActor: 'core_agent/gemini-3.5-flash',
      generatedBy: 'synthesis_agent/0.1.0',
      verifiedBy: 'process:leak-check@aaaaaaaaaaaa',
      staleAfter: staleAfter(),
      attestation: PASSING_ATTESTATION,
      evidence: EVIDENCE,
      traceId: 'abcdef00000000000000000000000001',
    });

    expect(document.metadata['request_id']).toBe(REQUEST_ID);
    expect(document.metadata['trace_id']).toBe('abcdef00000000000000000000000001');
    // They must survive the round trip so the stored document stays searchable.
    expect(parse(dump(document)).metadata['request_id']).toBe(REQUEST_ID);
  });

  it('survives a round trip with the attestation block intact', () => {
    const reparsed = parse(dump(answer()));
    expect(reparsed.metadata['attestation']).toEqual(answer().metadata['attestation']);
  });
});

describe('timestamps', () => {
  it('carries an explicit UTC offset', () => {
    // SPEC §5: every timestamp is ISO 8601 with an explicit UTC offset.
    expect(nowIso(new Date(Date.UTC(2026, 7, 24, 10, 0, 0)))).toBe('2026-08-24T10:00:00Z');
  });
});
