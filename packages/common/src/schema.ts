/**
 * zod schemas for every boundary the fleet exposes.
 *
 * One definition per payload, shared by the producer and the consumer: the web
 * UI derives its TypeScript types from these with `z.infer`, the gateway and
 * synthesis validate what they receive against them, and the LLM JSON responses
 * are parsed through them too. A boundary with a hand-written interface on one
 * side and a validator on the other is a boundary where the two drift apart.
 *
 * This module imports nothing from the vault, so the Core Agent can consume it
 * via the `@privacy-gateway/common/schema` subpath without gaining any path to
 * the token mapping.
 */

import { z } from 'zod';

// --- trust signals (OKF SPEC §5) --------------------------------------------

export const TrustTierSchema = z.enum(['unverified', 'machine-confirmed', 'human-reviewed']);
export type TrustTier = z.infer<typeof TrustTierSchema>;

export const AnswerStatusSchema = z.enum(['draft', 'stable', 'deprecated']);
export type AnswerStatus = z.infer<typeof AnswerStatusSchema>;

// --- attestation -------------------------------------------------------------

/** Verdict from the deterministic attester (`knowledge/references/attesters/leak_check.ts`). */
export const AttestationSchema = z
  .object({
    ok: z.boolean(),
    reason: z.string().nullable(),
    findings: z.array(z.string()),
    details: z.record(z.unknown()).optional(),
    judge: z
      .object({
        leak: z.boolean().nullable().optional(),
        categories: z.array(z.string()).optional(),
        error: z.string().optional(),
        raw: z.string().optional(),
      })
      .passthrough()
      .optional(),
    unresolved_tokens: z.array(z.string()).optional(),
  })
  .passthrough();
export type Attestation = z.infer<typeof AttestationSchema>;

/** Whether the Core agent invented placeholders that were absent from the input. */
export const ConsistencyReportSchema = z.object({
  ok: z.boolean(),
  invented_tokens: z.array(z.string()),
  known_tokens: z.array(z.string()),
  used_tokens: z.array(z.string()),
  reason: z.string().nullable(),
});
export type ConsistencyReport = z.infer<typeof ConsistencyReportSchema>;

/** The receipt the executor procedure specifies, minus the response body. */
export const ReceiptSummarySchema = z.object({
  session_id: z.string(),
  response_hash: z.string(),
  findings: z.array(z.string()),
});
export type ReceiptSummary = z.infer<typeof ReceiptSummarySchema>;

// --- OKF frontmatter (SPEC §5) ----------------------------------------------

/** One entry of `verified[]`. */
export const VerificationEventSchema = z
  .object({ by: z.string(), at: z.string().optional() })
  .passthrough();
export type VerificationEvent = z.infer<typeof VerificationEventSchema>;

/** One provenance entry; `resource` is the only required field. */
export const SourceSchema = z
  .object({
    id: z.string().optional(),
    resource: z.string(),
    title: z.string().optional(),
    author: z.string().optional(),
    usage_count: z.number().optional(),
    last_modified: z.string().optional(),
  })
  .passthrough();
export type Source = z.infer<typeof SourceSchema>;

/**
 * Frontmatter of a `Gateway Answer`.
 *
 * `passthrough` throughout: §11 forbids rejecting unknown keys, and the audit
 * trail must survive a round trip through a consumer that does not know every
 * extension this fleet writes (`request_id` / `trace_id` among them).
 */
export const GatewayAnswerFrontmatterSchema = z
  .object({
    type: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    session_id: z.string().optional(),
    request_id: z.string().optional(),
    trace_id: z.string().optional(),
    status: AnswerStatusSchema.optional(),
    generated: z.object({ by: z.string(), at: z.string().optional() }).passthrough().optional(),
    verified: z.union([VerificationEventSchema, z.array(VerificationEventSchema)]).optional(),
    stale_after: z.string().optional(),
    sources: z.array(SourceSchema).optional(),
  })
  .passthrough();
export type GatewayAnswerFrontmatter = z.infer<typeof GatewayAnswerFrontmatterSchema>;

// --- gateway HTTP API --------------------------------------------------------

export const AskRequestSchema = z.object({
  text: z.string().min(1, 'text must not be empty'),
  session_id: z.string().min(1).nullish(),
});
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskStatsSchema = z.object({
  masked_count: z.number(),
  counts_by_category: z.record(z.number()),
  unstructured_spans: z.number(),
  vault_expires_at: z.string(),
  core_actor: z.string(),
});
export type AskStats = z.infer<typeof AskStatsSchema>;

export const AskResponseSchema = z.object({
  session_id: z.string(),
  request_id: z.string(),
  /** Absent when tracing is disabled, so the UI must tolerate its absence. */
  trace_id: z.string().optional(),
  masked_prompt: z.string(),
  okf: z.string(),
  answer: z.string(),
  trust_tier: TrustTierSchema,
  status: AnswerStatusSchema,
  attestation: AttestationSchema,
  consistency: ConsistencyReportSchema,
  stats: AskStatsSchema,
});
export type AskResponse = z.infer<typeof AskResponseSchema>;

export const ApproveRequestSchema = z.object({
  approver: z.string().min(1).optional(),
});
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

export const ApproveResponseSchema = z.object({
  session_id: z.string(),
  request_id: z.string().optional(),
  trust_tier: TrustTierSchema,
  markdown: z.string(),
});
export type ApproveResponse = z.infer<typeof ApproveResponseSchema>;

export const TierResponseSchema = z.object({
  session_id: z.string(),
  trust_tier: TrustTierSchema,
  status: z.string(),
  stale: z.boolean(),
});
export type TierResponse = z.infer<typeof TierResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  agent: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Error body returned by every route, so the UI has one shape to render. */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  request_id: z.string().optional(),
  categories: z.array(z.string()).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// --- synthesis HTTP API ------------------------------------------------------

export const SynthesizeRequestSchema = z.object({
  session_id: z.string().min(1),
  masked_prompt: z.string(),
  core_answer: z.string(),
  generated_by: z.string().min(1),
  request_id: z.string().optional(),
});
export type SynthesizeRequest = z.infer<typeof SynthesizeRequestSchema>;

export const SynthesizeResponseSchema = z.object({
  session_id: z.string(),
  request_id: z.string().optional(),
  markdown: z.string(),
  answer: z.string(),
  trust_tier: TrustTierSchema,
  status: AnswerStatusSchema,
  attestation: AttestationSchema,
  consistency: ConsistencyReportSchema,
  receipt: ReceiptSummarySchema,
});
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;

// --- A2A ---------------------------------------------------------------------

/** A2A message part; only text parts are used by this fleet. */
export const A2aPartSchema = z
  .object({
    kind: z.string().optional(),
    text: z.string().optional(),
  })
  .passthrough();

export const A2aMessageSchema = z
  .object({
    role: z.string().optional(),
    parts: z.array(A2aPartSchema).optional(),
    messageId: z.string().optional(),
    contextId: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

/**
 * `message/send` result: per the A2A spec this is either a Message or a Task,
 * and a Task carries text in artifacts and in status.message.
 */
export const A2aResultSchema = z
  .object({
    parts: z.array(A2aPartSchema).optional(),
    artifacts: z
      .array(z.object({ parts: z.array(A2aPartSchema).optional() }).passthrough())
      .optional(),
    status: z.object({ message: A2aMessageSchema.optional() }).passthrough().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .passthrough();

export const JsonRpcResponseSchema = z
  .object({
    jsonrpc: z.string().optional(),
    id: z.union([z.string(), z.number()]).nullish(),
    result: A2aResultSchema.optional(),
    error: z
      .object({
        code: z.number().optional(),
        message: z.string().optional(),
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type JsonRpcResponse = z.infer<typeof JsonRpcResponseSchema>;

/** Agent Card, narrowed to the fields the client actually reads. */
export const AgentCardSchema = z
  .object({
    name: z.string().optional(),
    description: z.string().optional(),
    url: z.string().optional(),
    version: z.string().optional(),
  })
  .passthrough();
export type AgentCard = z.infer<typeof AgentCardSchema>;

// --- Gemma (LLM) JSON outputs ------------------------------------------------

/**
 * Unstructured PII spans returned by Gemma.
 *
 * No offsets are requested: a model cannot count character positions reliably,
 * so the gateway locates each span with `indexOf` instead and discards any text
 * absent from the input.
 */
export const SpanSchema = z.object({
  text: z.string().min(1),
  category: z.enum(['PERSON', 'ADDRESS', 'ORGANIZATION']),
});
export type Span = z.infer<typeof SpanSchema>;

export const SpanExtractionSchema = z.object({
  spans: z.array(SpanSchema),
});
export type SpanExtraction = z.infer<typeof SpanExtractionSchema>;

/** Advisory verdict from the Gemma leak judge; never decides pass or fail. */
export const LeakJudgeSchema = z.object({
  leak: z.boolean(),
  categories: z.array(z.string()).default([]),
});
export type LeakJudge = z.infer<typeof LeakJudgeSchema>;
