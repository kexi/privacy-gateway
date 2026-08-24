/** What OKF v0.2 parsing, assembly and trust signal derivation guarantee. */

import { describe, expect, it } from 'vitest';
import {
  addVerification,
  buildGatewayAnswer,
  dump,
  GATEWAY_ANSWER_TYPE,
  isStale,
  nowIso,
  parse,
  TRUST_HUMAN_REVIEWED,
  TRUST_MACHINE_CONFIRMED,
  TRUST_UNVERIFIED,
  trustTier,
  type AttestationLike,
} from '../src/okf.ts';

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
    sessionId: 's1',
    answerBody: 'Here is the reply.',
    generatedBy: 'core_agent/gemini-3.5-flash',
    verifiedBy: 'synthesis_agent/gemma3:12b',
    staleAfter: staleAfter(),
    attestation,
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
});

describe('staleness (SPEC §5.5)', () => {
  it('is stale once stale_after has passed', () => {
    expect(isStale({ stale_after: nowIso(new Date(Date.now() - 3600 * 1000)) })).toBe(true);
  });

  it('is fresh with a future stale_after', () => {
    expect(isStale({ stale_after: nowIso(new Date(Date.now() + 3600 * 1000)) })).toBe(false);
  });

  it('is never stale without stale_after', () => {
    expect(isStale({ type: 'Policy' })).toBe(false);
  });

  it('does not become stale from an unparseable stale_after', () => {
    // §11: a consumer must not reject a concept because of a malformed field.
    expect(isStale({ stale_after: 'sometime next week' })).toBe(false);
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
    expect((document.metadata['generated'] as { by: string }).by).toBe(
      'core_agent/gemini-3.5-flash',
    );
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

  it('cites the masked prompt and the policy', () => {
    const sources = answer().metadata['sources'] as Array<{ resource: string }>;
    const resources = sources.map((source) => source.resource);
    expect(resources).toContain('/sessions/s1/masked-prompt.md');
    expect(resources).toContain('/policies/pii-masking.md');
  });

  it('mirrors the vault expiry in stale_after', () => {
    const expiry = staleAfter();
    const document = buildGatewayAnswer({
      sessionId: 's1',
      answerBody: 'Reply.',
      generatedBy: 'core_agent/gemini-3.5-flash',
      verifiedBy: 'synthesis_agent/gemma3:12b',
      staleAfter: expiry,
      attestation: PASSING_ATTESTATION,
    });
    expect(document.metadata['stale_after']).toBe(nowIso(expiry));
  });

  it('raises a machine-confirmed answer to human-reviewed on approval', () => {
    const document = answer();
    expect(trustTier(document.metadata)).toBe(TRUST_MACHINE_CONFIRMED);

    addVerification(document, 'human:kei');
    expect(trustTier(document.metadata)).toBe(TRUST_HUMAN_REVIEWED);
    expect(document.metadata['verified']).toHaveLength(2);
  });

  it('stores the correlation ids as top-level extension keys', () => {
    const document = buildGatewayAnswer({
      sessionId: 's1',
      answerBody: 'Reply.',
      generatedBy: 'core_agent/gemini-3.5-flash',
      verifiedBy: 'synthesis_agent/gemma3:12b',
      staleAfter: staleAfter(),
      attestation: PASSING_ATTESTATION,
      requestId: '01920000-0000-7000-8000-000000000001',
      traceId: 'abcdef00000000000000000000000001',
    });

    expect(document.metadata['request_id']).toBe('01920000-0000-7000-8000-000000000001');
    expect(document.metadata['trace_id']).toBe('abcdef00000000000000000000000001');
    // They must survive the round trip so the stored document stays searchable.
    expect(parse(dump(document)).metadata['request_id']).toBe(
      '01920000-0000-7000-8000-000000000001',
    );
  });
});

describe('timestamps', () => {
  it('carries an explicit UTC offset', () => {
    // SPEC §5: every timestamp is ISO 8601 with an explicit UTC offset.
    expect(nowIso(new Date(Date.UTC(2026, 7, 24, 10, 0, 0)))).toBe('2026-08-24T10:00:00Z');
  });
});
