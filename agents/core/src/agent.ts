/**
 * Core Agent: receives only de-identified prompts and does the reasoning,
 * planning and code generation.
 *
 * This is the one agent that sits outside the trust boundary. It holds no
 * Firestore role and therefore cannot read the token vault — the guarantee is
 * **IAM**, granted (or rather, not granted) in `infra/terraform/iam.tf`. The
 * package graph reinforces it: Core imports only the `/logging`, `/config`,
 * `/schema` and `/telemetry` subpaths of the shared package, none of which reach
 * the vault. But a dependency edge is a convention a future commit can add, and
 * the missing IAM binding is what actually stops a read.
 */

import { LlmAgent } from '@google/adk';
import { getTracer, SPAN, type TraceSpan } from '@privacy-gateway/common/telemetry';

/** Model verified to exist on Vertex AI. Override with the GEMINI_MODEL env var. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash';

/**
 * System instruction governing how placeholders are handled.
 *
 * The point is to make the model treat the ⟦TYPE_N⟧ tokens substituted by the
 * Gateway as opaque. Three rules matter most — never ask for the real value,
 * never invent a new token, and reproduce each token byte for byte — because
 * breaking any of them fails the Synthesis agent's consistency check.
 */
export const CORE_SYSTEM_INSTRUCTION = `You are the Core reasoning agent in a privacy-preserving multi-agent gateway.

The prompts you receive have already been de-identified by an upstream Gateway agent.
Every piece of sensitive data has been replaced by an opaque placeholder token of the
form \`⟦TYPE_N⟧\` — for example \`⟦PERSON_1⟧\`, \`⟦EMAIL_1⟧\`, \`⟦PHONE_2⟧\`, \`⟦CARD_1⟧\`,
\`⟦SECRET_1⟧\`. A downstream Synthesis agent restores the real values before the user
sees your answer.

Rules about placeholders — these are absolute:

1. Treat each placeholder as an opaque, atomic identifier. It is a stable reference to a
   real value you are not permitted to know. Reason *about* it, never *into* it.
2. Reuse placeholders verbatim, byte for byte, including the ⟦ ⟧ brackets, the uppercase
   type name and the numeric suffix. Never re-case, translate, abbreviate, pluralise,
   split, or re-number them. \`⟦PERSON_1⟧\` and \`⟦Person_1⟧\` are not the same token.
3. Never invent a placeholder that did not appear in the input. If you need to refer to
   something that was not tokenised, describe it in plain words instead.
4. Never ask the user, the Gateway, or any tool to reveal, decode or "fill in" what a
   placeholder stands for. Never guess a plausible name, address, email or number for
   one. Never emit invented sample contact details in a position where a placeholder
   belongs — emit the placeholder itself.
5. Do not emit raw personal data of your own: no real-looking email addresses, phone
   numbers, credit-card numbers, or API keys, even as illustrations.
6. Placeholders are values, not code identifiers. When you generate code, keep them
   inside string literals or configuration, exactly as given, so the Synthesis agent can
   substitute them; never turn \`⟦EMAIL_1⟧\` into a variable name.
7. Distinct placeholders denote distinct values, and the same placeholder always denotes
   the same value throughout the conversation. Keep your reasoning consistent with that.

Within those rules, be genuinely useful: plan carefully, answer completely, and write
correct, idiomatic code. Placeholder discipline constrains how you refer to data — it is
not a reason to give a vague or hedged answer.`;

export interface CreateCoreAgentOptions {
  /** Model id. Falls back to the GEMINI_MODEL env var, then to the default. */
  readonly model?: string;
}

/** The agent's name on A2A; becomes the `name` field of the Agent Card. */
export const CORE_AGENT_NAME = 'core_agent';

/**
 * Builds the Core Agent.
 *
 * Credentials come from ADC, and whether Vertex AI is used is decided by the
 * environment (GOOGLE_GENAI_USE_VERTEXAI / GOOGLE_CLOUD_PROJECT /
 * GOOGLE_CLOUD_LOCATION). Why not read those variables here? Because
 * @google/genai already resolves them under one set of rules, and reading them
 * a second time would risk the two interpretations drifting apart.
 */
export function createCoreAgent(options: CreateCoreAgentOptions = {}): LlmAgent {
  const model = options.model ?? process.env['GEMINI_MODEL'] ?? DEFAULT_GEMINI_MODEL;

  // The Gemini call is the one hop the fleet cannot see from the outside, and
  // `docs/OBSERVABILITY.md` has always promised an `llm.gemini` span for it.
  //
  // Why start and end it across two callbacks rather than with `withSpan`: ADK
  // owns the call between them, so there is no function to wrap.
  //
  // The handle is keyed by the ADK callback context — one per in-flight model
  // call — rather than held on the agent. Cloud Run runs this service at
  // concurrency 40 over a single agent instance, so an agent-global handle let
  // one request's `afterModelCallback` end another request's span, producing a
  // trace that attributes latency to the wrong caller. A WeakMap also means a
  // call that never returns drops its span with its context instead of being
  // ended by whichever request happens to start next.
  const modelSpans = new WeakMap<object, TraceSpan>();

  return new LlmAgent({
    name: CORE_AGENT_NAME,
    description:
      'Reasoning, planning and code generation over de-identified text. Operates on ⟦TYPE_N⟧ placeholder tokens and has no access to the token vault.',
    model,
    instruction: CORE_SYSTEM_INSTRUCTION,
    beforeModelCallback: ({ context }) => {
      // Attributes are the model id only: the request carries the masked prompt,
      // and a span attribute is not the place for any prompt text.
      modelSpans.set(context, getTracer().startSpan(SPAN.llmGemini, { attributes: { model } }));
      return undefined;
    },
    afterModelCallback: ({ context }) => {
      const span = modelSpans.get(context);
      span?.end();
      modelSpans.delete(context);
      return undefined;
    },
    // No tools on purpose: the trust boundary assumes Core touches no external
    // resource of its own.
    tools: [],
  });
}
