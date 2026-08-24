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
import type { VerificationEvent } from './schema.ts';

export const TRUST_UNVERIFIED = 'unverified';
export const TRUST_MACHINE_CONFIRMED = 'machine-confirmed';
export const TRUST_HUMAN_REVIEWED = 'human-reviewed';

export const GATEWAY_ANSWER_TYPE = 'Gateway Answer';

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

/** Normalize `verified`. A bare mapping is treated as a one-element list (§5.2). */
function verifiedEntries(metadata: OkfMetadata): VerificationEvent[] {
  const verified = metadata['verified'];
  if (verified === undefined || verified === null) return [];

  if (Array.isArray(verified)) {
    return verified.filter(
      (entry): entry is VerificationEvent =>
        entry !== null && typeof entry === 'object' && !Array.isArray(entry),
    );
  }
  if (typeof verified === 'object') return [verified as VerificationEvent];
  return [];
}

/** Derive the §5.3 trust tier. The score is never stored; it is always derived here. */
export function trustTier(metadata: OkfMetadata): TrustTier {
  const entries = verifiedEntries(metadata);
  if (entries.length === 0) return TRUST_UNVERIFIED;

  const hasHuman = entries.some(
    (entry) => typeof entry.by === 'string' && entry.by.startsWith('human:'),
  );
  return hasHuman ? TRUST_HUMAN_REVIEWED : TRUST_MACHINE_CONFIRMED;
}

/** Stale when `now >= stale_after` (§5.5). Without `stale_after` it is never stale. */
export function isStale(metadata: OkfMetadata, now: Date = new Date()): boolean {
  const staleAfter = parseDate(metadata['stale_after']);
  if (staleAfter === null) return false;
  return now.getTime() >= staleAfter.getTime();
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

export interface BuildGatewayAnswerOptions {
  readonly sessionId: string;
  readonly answerBody: string;
  readonly generatedBy: string;
  readonly verifiedBy?: string | undefined;
  readonly staleAfter: Date;
  readonly attestation: AttestationLike;
  readonly maskedPromptResource?: string | undefined;
  readonly title?: string | undefined;
  readonly generatedAt?: Date | undefined;
  /** Correlation ids, stored as top-level extension keys for log/trace lookup. */
  readonly requestId?: string | undefined;
  readonly traceId?: string | undefined;
}

/**
 * Assemble the Synthesis Agent final output (`type: Gateway Answer`).
 *
 * When the leak check passes, the Synthesis actor is added to `verified` so the
 * document becomes machine-confirmed. When it fails, the document is marked
 * `status: draft` and the failure reason is kept in the `# Attestation` section
 * of the body (§10.5: a failed attestation must not be silently dropped).
 */
export function buildGatewayAnswer(options: BuildGatewayAnswerOptions): OkfDocument {
  const passed = options.attestation.ok === true;
  const maskedResource =
    options.maskedPromptResource ?? `/sessions/${options.sessionId}/masked-prompt.md`;
  const generatedAt = options.generatedAt ?? new Date();

  const metadata: OkfMetadata = {
    type: GATEWAY_ANSWER_TYPE,
    title: options.title ?? `Gateway answer for session ${options.sessionId}`,
    description: 'Rehydrated answer produced by the privacy-preserving gateway fleet.',
    tags: ['gateway', 'pii', 'attested'],
    session_id: options.sessionId,
    status: passed ? 'stable' : 'draft',
    generated: { by: options.generatedBy, at: nowIso(generatedAt) },
    stale_after: nowIso(options.staleAfter),
    sources: [
      {
        id: 'masked-prompt',
        resource: maskedResource,
        title: 'Masked prompt sent to the core agent',
        author: 'gateway_agent/tokenizer',
        last_modified: nowIso(generatedAt),
      },
      {
        id: 'pii-policy',
        resource: '/policies/pii-masking.md',
        title: 'PII masking policy',
        author: 'human:kei',
      },
    ],
  };

  // Correlation ids are extension keys rather than sources: they identify the
  // execution that produced this document, not a body of knowledge it drew on.
  if (options.requestId !== undefined) metadata['request_id'] = options.requestId;
  if (options.traceId !== undefined) metadata['trace_id'] = options.traceId;

  // Omitting verified on failure is what drops the trust tier to unverified.
  if (passed && options.verifiedBy !== undefined) {
    metadata['verified'] = [{ by: options.verifiedBy, at: nowIso() }];
  }

  const findings = options.attestation.findings ?? [];
  const verdictLine = passed ? 'passed' : `**failed** — ${options.attestation.reason ?? 'unknown'}`;
  const findingsBlock =
    findings.length > 0
      ? findings.map((finding) => `- \`${finding}\``).join('\n')
      : '- (no findings)';

  const content = `# Answer

${options.answerBody.trim()}

# Attestation

Leak check ${verdictLine}. The deterministic attester
([leak-check computation](/computations/leak-check.md)) inspected the receipt for
session \`${options.sessionId}\`.

Findings:

${findingsBlock}

The answer was produced from a masked prompt in which every detected identifier was
replaced by an opaque placeholder before it left the trust boundary.[^masked-prompt]
Masking follows the repository PII masking policy.[^pii-policy]

[^masked-prompt]: Masked prompt sent to the core agent
[^pii-policy]: PII masking policy
`;

  return { metadata, content };
}
