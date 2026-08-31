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

// --- categories ---------------------------------------------------------------

/**
 * Every category this fleet's tokenizer can allocate a placeholder for.
 *
 * Closed on purpose. `categories` travels from a Gemma judge response into logs
 * and into the public refusal body, so an open `z.array(z.string())` made a
 * model-controlled string a disclosure channel: a judge that answered
 * `categories: ["Taro Yamada"]` would have printed a real name into both. A
 * value outside this set is dropped, never truncated and never emitted.
 */
export const PII_CATEGORIES = [
  'EMAIL',
  'PHONE',
  'CREDIT_CARD',
  'MY_NUMBER',
  'IPV4',
  'API_KEY',
  'AWS_KEY',
  'JWT',
  'PERSON',
  'ADDRESS',
  'ORGANIZATION',
  /**
   * A term the requester named, matched literally rather than detected.
   *
   * The only category no detector can produce on its own: an unreleased product
   * name or an internal codename has no lexical form a regex could match and no
   * public meaning a model could recognise. The requester supplies the string,
   * and it is substituted before any detector runs.
   */
  'CUSTOM',
] as const;

export const PiiCategorySchema = z.enum(PII_CATEGORIES);
export type PiiCategory = z.infer<typeof PiiCategorySchema>;

/** True when `value` names a category this fleet recognises. */
export function isPiiCategory(value: unknown): value is PiiCategory {
  return typeof value === 'string' && (PII_CATEGORIES as readonly string[]).includes(value);
}

/**
 * The categories the disclosure policy withholds from a released answer by
 * default (`docs/ARCHITECTURE.md` §9).
 *
 * Duplicated from `DEFAULT_WITHHELD_CATEGORIES` in `tokenizer.ts` rather than
 * imported: this module imports nothing from the vault side so the Core Agent
 * can consume `@privacy-gateway/common/schema` without gaining a path to the
 * mapping, and the tokenizer reaches that side. A test in
 * `packages/common/test/schema.test.ts` asserts the two lists stay identical.
 */
export const HIGH_RISK_CATEGORIES = [
  'API_KEY',
  'AWS_KEY',
  'JWT',
  'CREDIT_CARD',
  'MY_NUMBER',
] as const;

export const HighRiskCategorySchema = z.enum(HIGH_RISK_CATEGORIES);
export type HighRiskCategory = z.infer<typeof HighRiskCategorySchema>;

/** True when `value` names a category the disclosure policy withholds by default. */
export function isHighRiskCategoryName(value: unknown): value is HighRiskCategory {
  return typeof value === 'string' && (HIGH_RISK_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Narrow an already-validated allow list back to its closed type.
 *
 * Needed where the list has travelled through a `readonly string[]` — the shape
 * the pipeline options use, so the disclosure policy stays one plain list of
 * strings — and is about to be written into a record whose schema is the closed
 * enum. The values were validated at the boundary; this only recovers the type.
 */
export function filterHighRiskCategories(values: readonly unknown[]): HighRiskCategory[] {
  return values.filter(isHighRiskCategoryName);
}

/**
 * A per-request disclosure opt-in: `{rehydrate_allow: [...]}`.
 *
 * Closed to the high-risk set on purpose, and validated rather than filtered. A
 * caller who names `EMAIL` is describing a category nothing withholds, so
 * accepting it would report success for an opt-in that changed nothing; a caller
 * who names `SUPERUSER` is either confused or probing. Both are a 400 — the
 * whole point of an explicit opt-in is that the requester knows what they asked
 * for.
 *
 * The list is deduplicated so `["JWT","JWT"]` is not a different request from
 * `["JWT"]`, and capped at the size of the set it draws from.
 */
export const RehydrateAllowSchema = z
  .array(HighRiskCategorySchema)
  .max(HIGH_RISK_CATEGORIES.length)
  .transform((values) => [...new Set(values)]);

// --- user-defined secret terms -----------------------------------------------

/** How many terms one request may name. */
export const MAX_MASK_TERMS = 20;
/** The shortest term worth masking, in characters after trimming. */
export const MIN_MASK_TERM_LENGTH = 2;
/** The longest term one request may name, in characters after trimming. */
export const MAX_MASK_TERM_LENGTH = 120;

/**
 * Phrases the requester wants masked verbatim, beyond anything a detector finds.
 *
 * The case is preserved and matching is **case-sensitive** (see
 * `substituteTerms` in `tokenizer.ts`). Deduplication is case-preserving for the
 * same reason: `Titan` and `titan` are two different requests, and collapsing
 * them would silently drop one.
 *
 * `⟦` and `⟧` are rejected outright rather than escaped. A term carrying either
 * delimiter is naming the placeholder namespace, which is exactly what
 * `containsReservedSyntax` refuses in the prompt itself; accepting it here would
 * be a second door into the same oracle.
 *
 * A term shorter than two characters is refused because a single character
 * matches nearly everywhere: masking every `a` in a prompt destroys the text
 * without protecting anything.
 */
export const MaskTermSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length >= MIN_MASK_TERM_LENGTH, {
    message: `each term must be at least ${MIN_MASK_TERM_LENGTH} characters after trimming`,
  })
  .refine((value) => value.length <= MAX_MASK_TERM_LENGTH, {
    message: `each term must be at most ${MAX_MASK_TERM_LENGTH} characters after trimming`,
  })
  .refine((value) => !value.includes('⟦') && !value.includes('⟧'), {
    message: 'a term must not contain the reserved placeholder delimiters ⟦ ⟧',
  });

export const MaskTermsSchema = z
  .array(MaskTermSchema)
  .min(1, 'mask_terms must not be empty')
  .max(MAX_MASK_TERMS, `at most ${MAX_MASK_TERMS} terms`)
  // Deduplicated after trimming, so `["Titan ", "Titan"]` is one term rather than
  // two placeholders for the same string. Case is part of the identity.
  .transform((values) => [...new Set(values)]);

/**
 * Keep only recognised categories, reporting how many were discarded.
 *
 * The count is kept because silently shortening a list would hide a judge that
 * has started answering in free text.
 */
export function filterPiiCategories(values: readonly unknown[]): {
  categories: PiiCategory[];
  dropped: number;
} {
  const categories: PiiCategory[] = [];
  let dropped = 0;
  for (const value of values) {
    if (isPiiCategory(value)) categories.push(value);
    else dropped += 1;
  }
  return { categories, dropped };
}

// --- attestation -------------------------------------------------------------

/**
 * A SHA-256 digest as it appears on the wire: 64 lowercase hex characters.
 *
 * Why not `z.string()`: the previous shape accepted the literal `unavailable`
 * that a mispackaged image produced, so a document could name a digest nobody
 * could ever fetch while still carrying `verified`.
 */
export const Sha256HexSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, 'must be 64 lowercase hex characters');

/**
 * What the single rehydration actually did, verified afterwards.
 *
 * Recorded rather than assumed. Rehydration is the one step that turns
 * placeholders back into real values, so "it substituted what it was supposed to
 * and nothing else" is the property most worth stating in the audit record — and
 * the pipeline refuses the release outright when the check that produces this
 * block does not come back `pass`. A released answer therefore never carries any
 * other verdict; the field is an enum rather than a boolean so a future
 * outcome that is neither can be added without a released `false`.
 */
/**
 * How many verbatim-mask terms this request named.
 *
 * A count and nothing else, in the attestation and in the OKF document alike. A
 * term is an enterprise secret by construction — that is the whole reason
 * someone names one — so the audit record states that the term scan ran and over
 * how many terms, and stops there. Why not a digest of each term: a codename is
 * drawn from a small guessable space, so a hash is a confirmation oracle, not a
 * redaction.
 */
export const CustomTermsReportSchema = z
  .object({
    count: z.number().int().min(0),
  })
  .passthrough();
export type CustomTermsReport = z.infer<typeof CustomTermsReportSchema>;

export const RehydrationReportSchema = z
  .object({
    /** How many distinct placeholders were replaced with their vault value. */
    substituted: z.number().int().min(0),
    /** Placeholders left masked on purpose, as token names, sorted. */
    withheld_remaining: z.array(z.string()),
    verdict: z.literal('pass'),
  })
  .passthrough();
export type RehydrationReport = z.infer<typeof RehydrationReportSchema>;

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
        categories: z.array(PiiCategorySchema).optional(),
      })
      .passthrough()
      .optional(),
    unresolved_tokens: z.array(z.string()).optional(),
    /** Categories left masked on purpose by the disclosure policy. */
    withheld: z.array(PiiCategorySchema).optional(),
    /**
     * The categories this request asked to have restored.
     *
     * Kept beside `withheld` rather than folded into it because they answer
     * different questions: `withheld` is what the reader did not get, this is
     * what the requester asked for. A record showing `disclosure_requested:
     * [CREDIT_CARD]` with `withheld: []` is the audit trail of a deliberate
     * disclosure; one showing the request with the category still in `withheld`
     * means the answer never mentioned it.
     */
    disclosure_requested: z.array(HighRiskCategorySchema).optional(),
    /** Present on a release; the post-rehydration completeness verdict. */
    rehydration: RehydrationReportSchema.optional(),
    /** How many verbatim-mask terms this request named; never the terms. */
    custom_terms: CustomTermsReportSchema.optional(),
    /**
     * How many category-enrichment attempts the advisory judge made on a
     * refusal — not verdict re-rolls. The judge's first `leak: true` is
     * terminal and always refuses; a second call only asks for the category
     * list when the first named none, and its `leak` value is never
     * consulted, so this field never appears on a release. Present only when
     * the enrichment call happened, and capped at one by the pipeline.
     */
    judge_retries: z.number().int().min(0).optional(),
  })
  .passthrough();
export type Attestation = z.infer<typeof AttestationSchema>;

/**
 * The `attestation:` frontmatter block of a `Gateway Answer`.
 *
 * Everything a third party needs to replay the verdict: which computation ran,
 * the digest of the code that ran it, and the digests of the two masked
 * artifacts the gateway serves.
 */
export const AttestationBlockSchema = z
  .object({
    computation: z.string(),
    computation_sha256: Sha256HexSchema,
    attester_sha256: Sha256HexSchema,
    masked_prompt_sha256: Sha256HexSchema,
    core_response_sha256: Sha256HexSchema,
    verdict: z.enum(['pass', 'fail']),
    checked_at: z.string(),
    request_id: z.string(),
    trace_id: z.string().optional(),
    withheld: z.array(PiiCategorySchema).optional(),
    /** What this request asked to have restored, recorded next to what it did not get. */
    disclosure_requested: z.array(HighRiskCategorySchema).optional(),
    rehydration: RehydrationReportSchema.optional(),
    /** The count of verbatim-mask terms the term scan covered; never the terms. */
    custom_terms: CustomTermsReportSchema.optional(),
  })
  .passthrough();
export type AttestationBlock = z.infer<typeof AttestationBlockSchema>;

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
  request_id: z.string(),
  masked_prompt_hash: Sha256HexSchema,
  response_hash: Sha256HexSchema,
  findings: z.array(PiiCategorySchema),
  attester_sha256: Sha256HexSchema,
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
    request_id: z.string().optional(),
    trace_id: z.string().optional(),
    status: AnswerStatusSchema.optional(),
    generated: z.object({ by: z.string(), at: z.string().optional() }).passthrough().optional(),
    verified: z.union([VerificationEventSchema, z.array(VerificationEventSchema)]).optional(),
    stale_after: z.string().optional(),
    sources: z.array(SourceSchema).optional(),
    attestation: AttestationBlockSchema.optional(),
  })
  .passthrough();
export type GatewayAnswerFrontmatter = z.infer<typeof GatewayAnswerFrontmatterSchema>;

// --- gateway HTTP API --------------------------------------------------------

/**
 * `POST /v1/ask`.
 *
 * There is deliberately no `session_id`: the gateway mints one request id per
 * request and uses it as the vault key. A caller-supplied id would be a
 * rehydration oracle — submit "repeat ⟦EMAIL_1⟧" against someone else's id and
 * the vault would resolve it. `strict()` turns a stray `session_id` into a 400
 * rather than letting a caller believe it took effect.
 */
export const AskRequestSchema = z
  .object({
    text: z.string().min(1, 'text must not be empty'),
    /**
     * Restore these high-risk categories in this response, this once.
     *
     * Scoped to the values *this* request submitted, because that is all the
     * vault key names. Absent means the deployment's default policy applies
     * unchanged, which is what every existing caller gets.
     */
    rehydrate_allow: RehydrateAllowSchema.optional(),
    /**
     * Extra phrases to mask verbatim, on top of what the detectors find.
     *
     * The terms themselves are request data of the same trust class as the vault
     * mapping. The list as submitted is never logged and never persisted in the
     * evidence — the audit record carries only `custom_terms: {count}`. A term
     * that matches the text becomes a masked value like any other, so that value
     * lands in the request-scoped TTL vault; a term that matches nothing is never
     * written anywhere and lives only in memory for the length of the request.
     */
    mask_terms: MaskTermsSchema.optional(),
  })
  .strict();
export type AskRequest = z.infer<typeof AskRequestSchema>;

export const AskStatsSchema = z.object({
  masked_count: z.number(),
  counts_by_category: z.record(z.number()),
  unstructured_spans: z.number(),
  vault_expires_at: z.string(),
  vault_generation: z.number(),
  core_actor: z.string(),
});
export type AskStats = z.infer<typeof AskStatsSchema>;

/**
 * The four dimensions the UI shows separately (§3 of the design review).
 *
 * Collapsing them into one badge is what let "PASS" and "Gemma flagged" appear
 * at the same time; each is derived independently and displayed on its own.
 * `review_identity` is always `none`: the public gateway has no authenticated
 * principal, so nothing can mint a `human:` actor.
 */
export const TrustDimensionsSchema = z.object({
  policy_verdict: z.enum(['pass', 'fail']),
  document_status: AnswerStatusSchema,
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  review_identity: z.literal('none'),
});
export type TrustDimensions = z.infer<typeof TrustDimensionsSchema>;

export const AskResponseSchema = z.object({
  request_id: z.string(),
  /** Absent when tracing is disabled, so the UI must tolerate its absence. */
  trace_id: z.string().optional(),
  masked_prompt: z.string(),
  okf: z.string(),
  /** Ephemeral: rehydrated for this response only and never persisted. */
  answer: z.string(),
  trust_tier: TrustTierSchema,
  status: AnswerStatusSchema,
  dimensions: TrustDimensionsSchema,
  attestation: AttestationSchema,
  consistency: ConsistencyReportSchema,
  stats: AskStatsSchema,
});
export type AskResponse = z.infer<typeof AskResponseSchema>;

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  agent: z.string(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// --- Fleet status -------------------------------------------------------------

/**
 * Whether the GPU-backed Gemma service is currently expected to be resident.
 *
 * `unknown` is a first-class answer, not an error: the state is inferred from a
 * recorded timestamp, and when that record cannot be read the honest report is
 * that nobody knows. Guessing `cold` would be a claim the gateway has not
 * earned, and guessing `warm` would promise a fast response it cannot deliver.
 *
 * `warming` is the same kind of honesty about the in-between: a wake has been
 * asked for and no Gemma call has landed since, so the instance is presumed to
 * be booting. It is not `warm` — nothing has answered yet — and reporting it as
 * `cold` would tell a user who just pressed the button that nothing happened.
 */
export const GemmaWarmthSchema = z.enum(['warm', 'warming', 'cold', 'unknown']);
export type GemmaWarmth = z.infer<typeof GemmaWarmthSchema>;

/**
 * The public status document.
 *
 * Deliberately tiny and free of anything request-derived: this endpoint
 * authenticates nobody, so every field here is world-readable by design. A
 * timestamp of the fleet's last activity and a fixed cold-start estimate reveal
 * nothing about who asked what.
 */
export const StatusResponseSchema = z.object({
  gemma: GemmaWarmthSchema,
  /** Absent when nothing was ever recorded, or when the store was unreachable. */
  last_active_at: z.string().optional(),
  /** When a wake was last asked for. Absent under the same conditions. */
  warmup_requested_at: z.string().optional(),
  cold_start_estimate_seconds: z.number(),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

/** The reply to `POST /v1/warmup`: the wake was dispatched, not that it finished. */
export const WarmupResponseSchema = z.object({
  started: z.literal(true),
});
export type WarmupResponse = z.infer<typeof WarmupResponseSchema>;

// --- Progress streaming (SSE on POST /v1/ask) ---------------------------------

/**
 * The pipeline stages a caller may be told about.
 *
 * These name *phases*, never content. The list is closed and lives here rather
 * than being derived from the pipeline's internals, so a new step cannot start
 * leaking a stage name that describes the request rather than the machinery.
 *
 * `gpu_wakeup` is emitted only when the fleet was cold on arrival: it explains a
 * two-minute wait that would otherwise look like a hang.
 */
export const ProgressStageSchema = z.enum([
  'gpu_wakeup',
  'masking',
  'egress_guard',
  'core_reasoning',
  'leak_check',
  'rehydrate',
]);
export type ProgressStage = z.infer<typeof ProgressStageSchema>;

/**
 * One progress frame.
 *
 * `stage` plus elapsed milliseconds and nothing else. There is no field here
 * that could carry prompt text, an answer fragment, a placeholder or a category
 * — the whole point of the fleet is that intermediate state stays inside the
 * boundary, and a progress channel is exactly where that discipline would be
 * easiest to lose.
 */
export const ProgressEventSchema = z
  .object({
    stage: ProgressStageSchema,
    elapsed_ms: z.number(),
    /** `start` opens a stage, `end` closes it; a UI can time each step from the pair. */
    state: z.enum(['start', 'end']),
  })
  .strict();
export type ProgressEvent = z.infer<typeof ProgressEventSchema>;

// --- OpenAI-compatible surface -----------------------------------------------

/**
 * The model id this gateway advertises on `GET /v1/models`.
 *
 * One id, not a passthrough of the underlying model names: a caller selects the
 * *fleet*, and which Gemini or Gemma version runs behind the boundary is
 * deployment topology the caller neither picks nor should depend on.
 */
export const OPENAI_MODEL_ID = 'privacy-gateway';

/**
 * One part of an OpenAI multimodal `content` array.
 *
 * Only `type: 'text'` is representable. Every other part kind — `image_url`,
 * `input_audio`, `file`, whatever OpenAI adds next — is carried by
 * `OpenAiNonTextPartSchema` below so the endpoint can name what it refused
 * instead of failing with a shape error that reads like a typo.
 */
export const OpenAiTextPartSchema = z
  .object({
    type: z.literal('text'),
    text: z.string(),
  })
  .strip();

/** Any content part that is not text; matched only to produce a precise refusal. */
export const OpenAiNonTextPartSchema = z
  .object({
    type: z.string(),
  })
  .passthrough();

/**
 * One message of an OpenAI `chat/completions` body.
 *
 * `content` is a string or an array of **text** parts. The multimodal array form
 * is accepted as a shape and then refused by name at the endpoint (see
 * `nonTextPartTypes` in `agents/gateway/src/openai_compat.ts`), which is the
 * whole point: this fleet masks text with regexes and a text model, and it has
 * no way to redact a face, a whiteboard, a screenshot of a credit card, or a
 * name spoken in an audio clip. Accepting an image and quietly dropping it would
 * send a prompt the caller never wrote; accepting it and forwarding it would put
 * unmaskable PII across the boundary. Refusing is the only fail-closed reading,
 * and it has to be explicit enough that a caller knows their image never went.
 *
 * `assistant` messages may carry `content: null` in a stock transcript (a
 * tool-call turn); they are dropped by the flattener regardless, so a null is
 * tolerated here rather than rejected as malformed.
 */
export const OpenAiChatMessageSchema = z
  .object({
    role: z.enum(['system', 'user', 'assistant']),
    content: z.union([
      z.string(),
      z.array(z.union([OpenAiTextPartSchema, OpenAiNonTextPartSchema])),
      z.null(),
    ]),
    name: z.string().optional(),
  })
  .strip();
export type OpenAiChatMessage = z.infer<typeof OpenAiChatMessageSchema>;

/**
 * `POST /v1/chat/completions`.
 *
 * Deliberately *not* `strict()`, unlike `AskRequestSchema`. An OpenAI client
 * sends sampling knobs (`temperature`, `top_p`, `max_tokens`, …) unprompted, and
 * rejecting the body for carrying them would make every stock SDK unusable. The
 * unknown keys are stripped rather than honoured — this fleet does not forward
 * sampling parameters — so nothing a caller sets here changes what Core sees.
 *
 * Why not accept `session_id`-like fields here either: there is still no session.
 * Multi-turn context is whatever the caller concatenated into `messages`, and
 * each request gets its own vault key.
 */
export const OpenAiChatCompletionRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(OpenAiChatMessageSchema).min(1, 'messages must not be empty'),
    stream: z.boolean().optional(),
    /**
     * The same namespaced extension the response carries, on the way in.
     *
     * The disclosure opt-in has no OpenAI field to live in, and inventing a
     * top-level `rehydrate_allow` would collide with whatever OpenAI ships under
     * that name later. `strict()` inside so a misspelled key here is a 400
     * rather than a silently ignored opt-in — the one failure mode an explicit
     * disclosure request must not have.
     */
    x_privacy_gateway: z
      .object({
        rehydrate_allow: RehydrateAllowSchema.optional(),
        /** The same verbatim-masking list `/v1/ask` takes, on the compat surface. */
        mask_terms: MaskTermsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strip();
export type OpenAiChatCompletionRequest = z.infer<typeof OpenAiChatCompletionRequestSchema>;

/**
 * The privacy facts an OpenAI-shaped response cannot express.
 *
 * The OpenAI schema has nowhere to put a trust tier, a masked prompt or a
 * withheld-category list, and dropping them would make the compatible endpoint a
 * way to consume this fleet *without* the evidence that justifies trusting it.
 * They travel in a namespaced extension field instead, which stock clients
 * ignore and an aware client can read.
 */
export const OpenAiPrivacyExtensionSchema = z.object({
  request_id: z.string(),
  trace_id: z.string().optional(),
  trust_tier: TrustTierSchema,
  status: AnswerStatusSchema,
  masked_prompt: z.string(),
  withheld: z.array(PiiCategorySchema),
  /**
   * Echoed so a caller can see the opt-in was understood.
   *
   * Omitted when the request made none, so a stock client's response shape is
   * unchanged and only a caller who asked for something learns what happened
   * to the request.
   */
  disclosure_requested: z.array(HighRiskCategorySchema).optional(),
});
export type OpenAiPrivacyExtension = z.infer<typeof OpenAiPrivacyExtensionSchema>;

export const OpenAiChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.literal('chat.completion'),
  created: z.number(),
  model: z.string(),
  choices: z.array(
    z.object({
      index: z.number(),
      message: z.object({
        role: z.literal('assistant'),
        content: z.string(),
      }),
      finish_reason: z.string(),
    }),
  ),
  x_privacy_gateway: OpenAiPrivacyExtensionSchema,
});
export type OpenAiChatCompletionResponse = z.infer<typeof OpenAiChatCompletionResponseSchema>;

/**
 * One part of a Responses-API `input` message's content array.
 *
 * The Responses API renames the text kinds: an input turn carries `input_text`,
 * an assistant turn carries `output_text`. Everything else — `input_image`,
 * `input_audio`, `input_file` — is non-text and is refused by name at the
 * endpoint for exactly the reason the chat surface refuses `image_url`: this
 * fleet masks text with regexes and a text model, and cannot redact a face or a
 * spoken name. `text` is optional because a non-text part has none, and the
 * union is discriminated by `type` alone.
 */
export const OpenAiResponsesContentPartSchema = z
  .object({
    type: z.string(),
    text: z.string().optional(),
  })
  .passthrough();

/** The text part kinds a Responses `input` message may carry. */
export const RESPONSES_TEXT_PART_TYPES: readonly string[] = ['input_text', 'output_text', 'text'];

/**
 * One message of a Responses-API `input` array.
 *
 * `role` is widened past the chat surface's three: Codex sends `developer`
 * turns for its base instructions, and rejecting them would make the CLI
 * unusable. A `developer` turn is treated as a system turn by the flattener.
 */
export const OpenAiResponsesInputMessageSchema = z
  .object({
    type: z.literal('message').optional(),
    role: z.enum(['system', 'developer', 'user', 'assistant']),
    content: z.union([z.string(), z.array(OpenAiResponsesContentPartSchema)]),
  })
  .strip();
export type OpenAiResponsesInputMessage = z.infer<typeof OpenAiResponsesInputMessageSchema>;

/**
 * One element of a Responses `input` array.
 *
 * Codex's `ResponseItem` is a tagged union far wider than `message`: reasoning
 * items, function calls, tool outputs. Only `message` carries text this fleet
 * can mask, so the rest are matched as opaque tagged objects and dropped by the
 * flattener — dropping a `reasoning` item the caller replayed loses nothing,
 * because this fleet never produced one.
 */
export const OpenAiResponsesInputItemSchema = z.union([
  OpenAiResponsesInputMessageSchema,
  z.object({ type: z.string() }).passthrough(),
]);

/**
 * `POST /v1/responses`.
 *
 * Codex CLI ≥ 0.149 dropped `chat/completions` for custom providers, so this is
 * the only wire a `wire_api = "responses"` provider can speak.
 *
 * Like the chat schema this is deliberately not `strict()`, and for a stronger
 * reason: Codex sends `reasoning`, `include`, `store`, `prompt_cache_key`,
 * `service_tier`, `text`, `parallel_tool_calls`, `tool_choice` and
 * `client_metadata` on every turn. Stripping them is honest — this fleet
 * forwards no sampling knob, caches no prompt and stores nothing keyed by a
 * caller-supplied id — and rejecting them would make the CLI unusable.
 *
 * `tools` is accepted and ignored. Why not reject a request that declares
 * tools: Codex always declares its shell toolset, so rejecting would refuse
 * every request. Why not emit tool calls: the fleet has no sandbox to run them
 * in and fabricating a call the model never made would be a lie the caller
 * would execute. The honest behaviour is to answer in text and never emit a
 * `function_call` item, which Codex reads as a turn that chose not to use a
 * tool.
 */
export const OpenAiResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    /** Codex sends its base prompt here rather than as a `system` turn. */
    instructions: z.string().optional(),
    input: z.union([z.string(), z.array(OpenAiResponsesInputItemSchema)]),
    stream: z.boolean().optional(),
    x_privacy_gateway: z
      .object({
        rehydrate_allow: RehydrateAllowSchema.optional(),
        mask_terms: MaskTermsSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strip();
export type OpenAiResponsesRequest = z.infer<typeof OpenAiResponsesRequestSchema>;

/**
 * The `response` object, in the shape Codex's SSE parser deserializes.
 *
 * `id` is required by Codex's `ResponseCompleted` struct: a `response.completed`
 * event without one fails the stream. `usage` is optional there but sent as
 * zeros here for the same reason the chat surface does — this fleet bills no
 * tokens, and omitting the field entirely makes a client's cost display read as
 * missing data rather than nothing spent.
 */
export const OpenAiResponsesObjectSchema = z.object({
  id: z.string(),
  object: z.literal('response'),
  created_at: z.number(),
  status: z.enum(['completed', 'failed']),
  model: z.string(),
  output: z.array(
    z.object({
      type: z.literal('message'),
      id: z.string(),
      status: z.literal('completed'),
      role: z.literal('assistant'),
      content: z.array(z.object({ type: z.literal('output_text'), text: z.string() })),
    }),
  ),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    total_tokens: z.number(),
  }),
  x_privacy_gateway: OpenAiPrivacyExtensionSchema,
});
export type OpenAiResponsesObject = z.infer<typeof OpenAiResponsesObjectSchema>;

export const OpenAiModelSchema = z.object({
  id: z.string(),
  object: z.literal('model'),
  created: z.number(),
  owned_by: z.string(),
});

export const OpenAiModelListSchema = z.object({
  object: z.literal('list'),
  data: z.array(OpenAiModelSchema),
});
export type OpenAiModelList = z.infer<typeof OpenAiModelListSchema>;

/** Error body returned by every route, so the UI has one shape to render. */
export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
  request_id: z.string().optional(),
  categories: z.array(PiiCategorySchema).optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

/**
 * A refusal delivered inside an SSE stream.
 *
 * Identical to `ErrorResponseSchema` plus the HTTP status the request would have
 * carried. The status has to travel in the body because the response code is
 * already committed to 200 by the time the first progress frame is flushed, and
 * a streaming client must still be able to tell a 400 from a 502.
 */
export const StreamRefusalSchema = ErrorResponseSchema.extend({
  status: z.number().optional(),
});
export type StreamRefusal = z.infer<typeof StreamRefusalSchema>;

// --- synthesis HTTP API ------------------------------------------------------

/**
 * `POST /v1/synthesize`.
 *
 * `known_tokens` and `vault_generation` come from the gateway's tokenizer, not
 * from the prompt text: deriving the trusted token set by re-scanning the prompt
 * would trust whatever the caller managed to get echoed into it.
 */
export const SynthesizeRequestSchema = z.object({
  request_id: z.string().min(1),
  masked_prompt: z.string(),
  core_answer: z.string(),
  generated_by: z.string().min(1),
  /** Exactly the placeholders the tokenizer allocated for this request. */
  known_tokens: z.array(z.string()),
  /** The vault generation the gateway wrote; rehydration refuses any other. */
  vault_generation: z.number().int().positive(),
  /**
   * The categories this request asked to have restored.
   *
   * Forwarded from `/v1/ask` rather than re-read from an environment variable
   * here: the opt-in is a property of one request, and Synthesis is the process
   * that applies the disclosure policy, so the two have to travel together. It
   * is validated again on arrival because this is its own boundary — a hop that
   * trusted the caller to have validated would let an internal misroute widen
   * the policy.
   */
  rehydrate_allow: RehydrateAllowSchema.optional(),
  /**
   * The requester's verbatim-mask terms, so the attester can scan for them.
   *
   * Inside-boundary data of the same trust class as the vault mapping: Synthesis
   * already holds every raw value behind every placeholder, so a term adds no new
   * exposure to this hop — and without it the deterministic attester has no way
   * to catch Core echoing a codename that no regex knows. It is scanned and
   * discarded: the evidence document records only `custom_terms: {count}`, never
   * a term, and no hop outside the boundary ever receives this field.
   */
  mask_terms: MaskTermsSchema.optional(),
});
export type SynthesizeRequest = z.infer<typeof SynthesizeRequestSchema>;

export const SynthesizeResponseSchema = z.object({
  request_id: z.string(),
  markdown: z.string(),
  answer: z.string(),
  trust_tier: TrustTierSchema,
  status: AnswerStatusSchema,
  dimensions: TrustDimensionsSchema,
  attestation: AttestationSchema,
  consistency: ConsistencyReportSchema,
  receipt: ReceiptSummarySchema,
});
export type SynthesizeResponse = z.infer<typeof SynthesizeResponseSchema>;

/**
 * Why Synthesis refused to release an answer.
 *
 * Each maps to a distinct HTTP status so the gateway can pass the reason through
 * without re-deriving it: a vault problem is a 409/410, a policy failure a 422.
 */
export const ReleaseRefusalSchema = z.object({
  error: z.string(),
  message: z.string(),
  request_id: z.string(),
  /** Category-level only; never a value, never the Core body. */
  categories: z.array(PiiCategorySchema),
  status_code: z.number().int(),
});
export type ReleaseRefusal = z.infer<typeof ReleaseRefusalSchema>;

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

/**
 * Advisory verdict from the Gemma leak judge; never decides pass or fail.
 *
 * `categories` is parsed leniently and then narrowed: a model may emit any
 * string, so unknown entries are discarded here rather than forwarded into logs
 * and the public refusal body. `dropped_categories` records how many were
 * discarded so a judge answering in prose is visible in the telemetry.
 */
export const LeakJudgeSchema = z
  .object({
    leak: z.boolean(),
    categories: z.array(z.unknown()).default([]),
  })
  .transform((value) => {
    const { categories, dropped } = filterPiiCategories(value.categories);
    return { leak: value.leak, categories, dropped_categories: dropped };
  });
export type LeakJudge = z.infer<typeof LeakJudgeSchema>;
