/**
 * Primitives shared inside the trust boundary.
 *
 * The Core Agent must NOT import this entry point: it re-exports the vault and
 * the tokenizer, and Core's inability to reach the token mapping is a structural
 * guarantee expressed in the dependency graph. Core imports the
 * `@privacy-gateway/common/{logging,config,schema,telemetry}` subpaths instead,
 * none of which reach the vault.
 */

export * from './a2a.ts';
export * from './config.ts';
export * from './guard.ts';
export * from './logging.ts';
export * from './request_id.ts';
export * from './telemetry.ts';
export * from './tokenizer.ts';
export * from './vault.ts';

// `TrustTier` is defined twice on purpose: `okf` derives it from frontmatter,
// `schema` validates it on the wire. They are the same union, and the schema one
// is the boundary type callers should reach for, so it wins the bare name.
export * from './schema.ts';
export {
  addVerification,
  buildGatewayAnswer,
  dump,
  GATEWAY_ANSWER_TYPE,
  GatewayAnswerFrontmatterSchema,
  isStale,
  nowIso,
  parse,
  SourceSchema,
  TRUST_HUMAN_REVIEWED,
  TRUST_MACHINE_CONFIRMED,
  TRUST_UNVERIFIED,
  trustTier,
  VerificationEventSchema,
} from './okf.ts';
export type {
  AttestationLike,
  BuildGatewayAnswerOptions,
  GatewayAnswerFrontmatter,
  OkfDocument,
  OkfMetadata,
  Source,
  TrustTier as OkfTrustTier,
  VerificationEvent,
} from './okf.ts';

// `DEFAULT_GEMMA_MODEL` is declared in both `config` (as the env default) and
// `ollama_llm` (as the adapter default). `config` is the single source of truth,
// so the adapter's copy is not re-exported here.
export {
  DEFAULT_GEMMA_BASE_URL,
  ollamaModelId,
  OllamaLlm,
  registerOllamaLlm,
  toChatMessages,
  wantsJson,
} from './ollama_llm.ts';
export type { OllamaLlmOptions } from './ollama_llm.ts';
