/**
 * Reading and writing OKF v0.2 documents, and deriving trust signals.
 *
 * Specification: https://github.com/GoogleCloudPlatform/open-knowledge-format
 * (the full SPEC.md lives at `skills/okf/references/SPEC.md`). This module
 * implements only §5 (provenance / trust / lifecycle) and §7 (actor
 * conventions); unknown keys and unknown `type` values are preserved verbatim so
 * they round-trip (§11: a consumer must not reject them).
 */

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isSha256Hex } from './attestation.ts';
import type { VerificationEvent } from './schema.ts';

export const TRUST_UNVERIFIED = 'unverified';
export const TRUST_MACHINE_CONFIRMED = 'machine-confirmed';
export const TRUST_HUMAN_REVIEWED = 'human-reviewed';

export const GATEWAY_ANSWER_TYPE = 'Gateway Answer';

/**
 * The route prefix under which the gateway serves a request's masked artifacts.
 *
 * The `sources[].resource` values are built from this so the document names the
 * path that actually resolves. Changing the routes means changing this constant;
 * `packages/common/test/okf.test.ts` asserts the two agree.
 */
export const REQUEST_ARTIFACT_BASE = '/v1/requests';

export type TrustTier =
  | typeof TRUST_UNVERIFIED
  | typeof TRUST_MACHINE_CONFIRMED
  | typeof TRUST_HUMAN_REVIEWED;

// The frontmatter schemas live in `schema.ts` so the web UI can validate a
// document without importing this module, which reaches the vault-side helpers.
export {
  GatewayAnswerFrontmatterSchema,
  SourceSchema,
  VerificationEventSchema,
  type GatewayAnswerFrontmatter,
  type Source,
  type VerificationEvent,
} from './schema.ts';

/** Arbitrary OKF frontmatter; only `type` is required by the spec (§4). */
export type OkfMetadata = Record<string, unknown>;

/** A single OKF concept. `metadata` holds the frontmatter verbatim. */
export interface OkfDocument {
  metadata: OkfMetadata;
  content: string;
}

/** Parse OKF Markdown. Missing frontmatter is not an error (§11). */
export function parse(text: string): OkfDocument {
  if (!text.startsWith('---')) {
    return { metadata: {}, content: text };
  }

  // Starting just after the opening delimiter, look for a line-initial `---` or
  // `...` as the terminator.
  const lines = text.split('\n');
  let endIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index]?.trimEnd();
    if (line === '---' || line === '...') {
      endIndex = index;
      break;
    }
  }
  if (endIndex === -1) return { metadata: {}, content: text };

  const rawFront = lines.slice(1, endIndex).join('\n');
  let metadata: OkfMetadata;
  try {
    const loaded: unknown = parseYaml(rawFront);
    metadata =
      loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)
        ? (loaded as OkfMetadata)
        : {};
  } catch {
    // The body should stay readable even with broken YAML, so return just the
    // body instead of rejecting the document.
    return { metadata: {}, content: text };
  }

  return {
    metadata,
    content: lines
      .slice(endIndex + 1)
      .join('\n')
      .replace(/^\n+/u, ''),
  };
}

/** Assemble OKF Markdown. Key order is preserved as insertion order. */
export function dump(document: OkfDocument): string {
  if (Object.keys(document.metadata).length === 0) return document.content;

  const front = stringifyYaml(document.metadata, { lineWidth: 0 }).replace(/\n+$/u, '');
  const body = document.content.replace(/^\n+/u, '').replace(/\n+$/u, '');
  return `---\n${front}\n---\n\n${body}\n`;
}

/**
 * Normalize `verified`, keeping only entries that carry a usable actor.
 *
 * §11 says a malformed field must not make the document unreadable, so the raw
 * value stays in `metadata` untouched; what this returns is the subset the trust
 * derivation is allowed to count. An entry without a string `by` names nobody,
 * and counting it would let `verified: [{}]` claim machine confirmation.
 */
function verifiedEntries(metadata: OkfMetadata): VerificationEvent[] {
  const verified = metadata['verified'];
  if (verified === undefined || verified === null) return [];

  const candidates: unknown[] = Array.isArray(verified) ? verified : [verified];
  return candidates.filter(
    (entry): entry is VerificationEvent =>
      entry !== null &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      typeof (entry as { by?: unknown }).by === 'string' &&
      (entry as { by: string }).by.trim() !== '',
  );
}

/** Derive the §5.3 trust tier. The score is never stored; it is always derived here. */
export function trustTier(metadata: OkfMetadata): TrustTier {
  const entries = verifiedEntries(metadata);
  if (entries.length === 0) return TRUST_UNVERIFIED;

  const hasHuman = entries.some((entry) => entry.by.startsWith('human:'));
  return hasHuman ? TRUST_HUMAN_REVIEWED : TRUST_MACHINE_CONFIRMED;
}

/** How fresh a document is, with "cannot tell" kept distinct from "fresh". */
export type Freshness = 'fresh' | 'stale' | 'unknown';

/**
 * Derive freshness from `stale_after` (§5.5).
 *
 * An absent or unparseable value yields `unknown`, never `fresh`: a document
 * whose expiry cannot be read is exactly the one whose freshness must not be
 * asserted.
 */
export function freshness(metadata: OkfMetadata, now: Date = new Date()): Freshness {
  const raw = metadata['stale_after'];
  if (raw === undefined || raw === null) return 'unknown';

  const staleAfter = parseDate(raw);
  if (staleAfter === null) return 'unknown';
  return now.getTime() >= staleAfter.getTime() ? 'stale' : 'fresh';
}

/**
 * Stale when `now >= stale_after` (§5.5).
 *
 * `unknown` counts as stale here, so a caller that only asks the yes/no question
 * fails closed; a caller that needs the distinction calls `freshness`.
 */
export function isStale(metadata: OkfMetadata, now: Date = new Date()): boolean {
  return freshness(metadata, now) !== 'fresh';
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string') return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Return an ISO 8601 string with an explicit UTC offset (`2026-08-24T10:00:00Z`). */
export function nowIso(moment: Date = new Date()): string {
  // Seconds precision: OKF timestamps are audit metadata, and millisecond noise
  // only makes documents harder to diff.
  return `${moment.toISOString().slice(0, 19)}Z`;
}

/** Append one verification event to `verified`, normalizing a bare mapping to a list. */
export function addVerification(
  document: OkfDocument,
  actor: string,
  at: Date = new Date(),
): OkfDocument {
  const entries = verifiedEntries(document.metadata);
  entries.push({ by: actor, at: nowIso(at) });
  document.metadata['verified'] = entries;
  return document;
}

/** The verdict shape the deterministic attester returns. */
export interface AttestationLike {
  readonly ok?: boolean;
  readonly reason?: string | null;
  readonly findings?: readonly string[];
  readonly [key: string]: unknown;
}

/** The replayable evidence written into the `attestation:` block. */
export interface AttestationEvidence {
  readonly computation: string;
  readonly computationSha256: string;
  readonly attesterSha256: string;
  readonly maskedPromptSha256: string;
  readonly coreResponseSha256: string;
  readonly checkedAt: Date;
  /** Categories the disclosure policy kept masked in the released answer. */
  readonly withheld?: readonly string[] | undefined;
  /**
   * Categories the requester asked to have restored for this request alone.
   *
   * Recorded beside `withheld` because a disclosure that happened on purpose and
   * one that happened by accident produce the same released text; only the
   * record distinguishes them, and the record is the product.
   */
  readonly disclosureRequested?: readonly string[] | undefined;
  /** The post-rehydration completeness verdict; present only on a release. */
  readonly rehydration?:
    | {
        readonly substituted: number;
        readonly withheld_remaining: readonly string[];
        readonly verdict: 'pass';
      }
    | undefined;
}

export interface BuildGatewayAnswerOptions {
  readonly requestId: string;
  /**
   * The **masked** answer body.
   *
   * The rehydrated text is returned to the caller ephemerally and never reaches
   * this function: a stored document containing real values would be exactly the
   * indefinite PII persistence the design forbids.
   */
  readonly maskedAnswerBody: string;
  /** The Core model actor, recorded as the author of the response *source*. */
  readonly coreActor: string;
  /** The document generator: this fleet's Synthesis agent, which assembled it. */
  readonly generatedBy: string;
  /** The actor that decided the verdict; a `process:` id, never an LLM. */
  readonly verifiedBy?: string | undefined;
  readonly staleAfter: Date;
  readonly attestation: AttestationLike;
  readonly evidence: AttestationEvidence;
  readonly title?: string | undefined;
  readonly generatedAt?: Date | undefined;
  readonly traceId?: string | undefined;
}

/**
 * Assemble the Synthesis Agent final output (`type: Gateway Answer`).
 *
 * `generated.by` names Synthesis: Core supplies tokenized prose, but this fleet
 * assembles the concept, and §7 attributes a document to whoever wrote it. The
 * Core invocation appears as provenance instead — a `core-response` source
 * authored by the Core model — so the reader can see both without either being
 * misattributed.
 *
 * When the leak check passes, the deterministic attester is added to `verified`
 * so the document becomes machine-confirmed. When it fails, the document is
 * marked `status: draft`, `verified` is omitted, and the failure is kept in the
 * `# Attestation` section (§10.5: a failed attestation must not be dropped).
 */
export function buildGatewayAnswer(options: BuildGatewayAnswerOptions): OkfDocument {
  const generatedAt = options.generatedAt ?? new Date();
  const { requestId, evidence } = options;

  // A digest that is not 64 hex characters names bytes nobody can fetch, so the
  // document cannot be machine-confirmed over it. Failing the attestation here —
  // rather than emitting `verified` beside an unusable digest — is what keeps
  // "machine-confirmed" a claim a third party can actually check.
  const digestsUsable =
    isSha256Hex(evidence.computationSha256) &&
    isSha256Hex(evidence.attesterSha256) &&
    isSha256Hex(evidence.maskedPromptSha256) &&
    isSha256Hex(evidence.coreResponseSha256);
  const passed = options.attestation.ok === true && digestsUsable;

  const metadata: OkfMetadata = {
    type: GATEWAY_ANSWER_TYPE,
    title: options.title ?? `Gateway answer for request ${requestId}`,
    description:
      'Masked evidence for one gateway exchange. The rehydrated answer is returned to the ' +
      'caller in the response body only and is not stored here.',
    tags: ['gateway', 'pii', 'attested'],
    request_id: requestId,
    status: passed ? 'stable' : 'draft',
    generated: { by: options.generatedBy, at: nowIso(generatedAt) },
    stale_after: nowIso(options.staleAfter),
    sources: [
      {
        id: 'masked-prompt',
        // The path the gateway actually serves, byte for byte. It used to omit
        // the `/v1` prefix, so following the provenance link as an
        // origin-relative URL returned 404 and the document was unreplayable.
        resource: `${REQUEST_ARTIFACT_BASE}/${requestId}/masked-prompt.md`,
        title: 'Masked prompt sent to the core agent',
        author: 'gateway_agent/tokenizer',
        last_modified: nowIso(generatedAt),
      },
      {
        id: 'core-response',
        resource: `${REQUEST_ARTIFACT_BASE}/${requestId}/core-response.md`,
        title: 'Tokenized response returned by the core agent',
        author: options.coreActor,
        last_modified: nowIso(generatedAt),
      },
      {
        id: 'pii-policy',
        resource: '/policies/pii-masking.md',
        title: 'PII masking policy',
        author: 'human:kei',
      },
    ],
    attestation: {
      computation: evidence.computation,
      computation_sha256: evidence.computationSha256,
      attester_sha256: evidence.attesterSha256,
      masked_prompt_sha256: evidence.maskedPromptSha256,
      core_response_sha256: evidence.coreResponseSha256,
      verdict: passed ? 'pass' : 'fail',
      checked_at: nowIso(evidence.checkedAt),
      request_id: requestId,
      ...(options.traceId !== undefined ? { trace_id: options.traceId } : {}),
      ...(evidence.withheld !== undefined && evidence.withheld.length > 0
        ? { withheld: [...evidence.withheld] }
        : {}),
      ...(evidence.disclosureRequested !== undefined && evidence.disclosureRequested.length > 0
        ? { disclosure_requested: [...evidence.disclosureRequested] }
        : {}),
      ...(evidence.rehydration !== undefined
        ? {
            rehydration: {
              substituted: evidence.rehydration.substituted,
              withheld_remaining: [...evidence.rehydration.withheld_remaining],
              verdict: evidence.rehydration.verdict,
            },
          }
        : {}),
    },
  };

  // The trace id is also a top-level extension key so a log query can find the
  // document without parsing the attestation block.
  if (options.traceId !== undefined) metadata['trace_id'] = options.traceId;

  // Omitting verified on failure is what drops the trust tier to unverified.
  if (passed && options.verifiedBy !== undefined) {
    metadata['verified'] = [{ by: options.verifiedBy, at: nowIso(evidence.checkedAt) }];
  }

  const findings = options.attestation.findings ?? [];
  const failureReason = digestsUsable
    ? (options.attestation.reason ?? 'unknown')
    : 'the build recorded no usable attestation digests, so the verdict cannot be replayed';
  const verdictLine = passed ? 'passed' : `**failed** — ${failureReason}`;
  const findingsBlock =
    findings.length > 0
      ? findings.map((finding) => `- \`${finding}\``).join('\n')
      : '- (no findings)';
  const withheldBlock =
    evidence.withheld !== undefined && evidence.withheld.length > 0
      ? `\nThe disclosure policy kept these categories masked in the released answer: ` +
        `${evidence.withheld.map((category) => `\`${category}\``).join(', ')}.\n`
      : '';
  // Stated in prose as well as in the frontmatter: a reader scanning the
  // document for "was anything high-risk deliberately given back" should not
  // have to know which YAML key to look under.
  const disclosureBlock =
    evidence.disclosureRequested !== undefined && evidence.disclosureRequested.length > 0
      ? `\nThe requester asked, for this request only, that these high-risk categories be ` +
        `restored: ${evidence.disclosureRequested.map((c) => `\`${c}\``).join(', ')}. The ` +
        `opt-in covers only values submitted in this same request.\n`
      : '';
  const rehydrationBlock =
    evidence.rehydration !== undefined
      ? `\nRehydration check: ${evidence.rehydration.substituted} placeholder(s) restored, ` +
        `${evidence.rehydration.withheld_remaining.length} left masked, verdict ` +
        `\`${evidence.rehydration.verdict}\`. The released text was verified to contain exactly ` +
        `the withheld placeholders, the exact vault value for every restored one, and no other ` +
        `identifier.\n`
      : '';

  const content = `# Answer (masked)

${options.maskedAnswerBody.trim()}

The rehydrated form of this answer was returned to the caller in the API response and is
deliberately not stored. Only the masked text above, the hashes below, and the category
counts are retained.
${withheldBlock}${disclosureBlock}${rehydrationBlock}
# Attestation

Leak-policy check ${verdictLine}. It confirms only that the core agent's tokenized
response carried no raw identifier of its own; it is not a factual validation of the
answer. The verdict was decided by the deterministic attester named in
\`attestation.attester_sha256\`, following
[the leak-check computation](/computations/leak-check.md), over the masked prompt and
core response whose digests are recorded in the \`attestation\` block.

Findings:

${findingsBlock}

Replay it with \`just verify-answer ${requestId}\`.

The answer was produced from a masked prompt in which every detected identifier was
replaced by an opaque placeholder before it left the trust boundary.[^masked-prompt] The
core agent's tokenized response is the input the check ran over.[^core-response] Masking
follows the repository PII masking policy.[^pii-policy]

[^masked-prompt]: Masked prompt sent to the core agent
[^core-response]: Tokenized response returned by the core agent
[^pii-policy]: PII masking policy
`;

  return { metadata, content };
}
