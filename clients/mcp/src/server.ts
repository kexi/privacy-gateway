/**
 * The MCP tool surface over the Privacy-Preserving Gateway.
 *
 * Three tools, matching the three things a caller can do with the fleet: send a
 * request across the trust boundary (`pgw_ask`), fetch the stored masked audit
 * document (`pgw_evidence`), and independently replay one answer's attestation
 * (`pgw_verify`).
 *
 * Two conventions run through all of them.
 *
 * **A refusal is a result, not an exception.** Every gate in this fleet fails
 * closed, and a refusal is the system working. Thrown MCP errors read to a model
 * as "the tool broke, try again"; these tools return `isError: false` with a
 * structured `refused` payload instead, so the model can explain *what* was
 * refused and *why* rather than retrying around a safety gate.
 *
 * **Nothing logs the request text.** The whole point of the gateway is that raw
 * PII does not leave the boundary; an MCP server that echoed prompts to stderr
 * would reintroduce exactly the leak the fleet exists to prevent. Diagnostics
 * carry the request id and nothing else.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  DEFAULT_GATEWAY_URL,
  GatewayClient,
  trustTier,
  verify,
  type GatewayFailure,
} from './client.ts';

/**
 * The sentence every tool description carries.
 *
 * A model that treats a 422 as a transient error will rephrase the prompt and
 * send it again, which is precisely the behaviour a privacy gate must not
 * provoke: the second attempt is another attempt to move the same PII across the
 * same boundary.
 */
const NO_RETRY_NOTE =
  'If this returns refused=true, a safety gate declined the request. Do NOT retry, ' +
  'rephrase, or work around it — explain the refusal and its categories to the user. ' +
  'The gates fail closed by design; a retry is another attempt to move the same data ' +
  'across the same boundary.';

/** JSON, rendered for a transport whose content blocks are text. */
function jsonContent(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

/** Render a gateway failure as a structured, non-throwing tool result. */
function refusal(failure: GatewayFailure) {
  return jsonContent({
    refused: true,
    status: failure.status,
    error: failure.error,
    message: failure.message,
    categories: failure.categories,
    request_id: failure.requestId,
    // Stated in the payload as well as the description: the model reads the
    // result far more reliably than it recalls the schema it called.
    guidance:
      'A fail-closed gate refused this request. Explain the refusal to the user; ' +
      'do not retry or rephrase to get around it.',
  });
}

export interface BuildServerOptions {
  readonly gatewayUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

/** Builds the MCP server. Wiring a transport is the caller's job. */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const client = new GatewayClient({
    baseUrl: options.gatewayUrl ?? process.env['PGW_GATEWAY_URL'] ?? DEFAULT_GATEWAY_URL,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
  });

  const server = new McpServer({
    name: 'privacy-gateway',
    version: '0.1.0',
  });

  server.registerTool(
    'pgw_ask',
    {
      title: 'Ask through the privacy gateway',
      description:
        'Send a question through the privacy-preserving gateway. PII in the text is ' +
        'masked with placeholders before any frontier model sees it, and the answer is ' +
        'rehydrated for you only in the response. Returns the answer, the masked prompt ' +
        'that actually crossed the boundary, the derived trust tier, and any categories ' +
        'the disclosure policy withheld. Masking is pseudonymization, not anonymization: ' +
        'placeholders disclose category and equality, and surviving quasi-identifiers can ' +
        'still permit contextual re-identification. ' +
        NO_RETRY_NOTE,
      inputSchema: {
        text: z
          .string()
          .min(1)
          .describe('The request, in the clear; it is masked before it leaves.'),
        mask_terms: z
          .array(z.string().min(2).max(120))
          .min(1)
          .max(20)
          .optional()
          .describe(
            'Extra phrases to mask verbatim, beyond what the detectors find — unreleased ' +
              'product names, internal codenames, anything confidential that has no ' +
              'detectable shape. Matched exactly and case-sensitively, so pass the term ' +
              'with the capitalisation it actually uses. Each becomes a ⟦CUSTOM_n⟧ ' +
              'placeholder and is restored in the answer you get back.',
          ),
      },
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ text, mask_terms: maskTerms }) => {
      const result = await client.ask(text, maskTerms ?? []);
      if (!result.ok) return refusal(result);

      const payload = result.value;
      return jsonContent({
        refused: false,
        answer: payload.answer,
        // What the frontier model actually saw. Surfaced so the caller can show
        // the user that the boundary held.
        masked_prompt: payload.masked_prompt,
        // Re-derived from the OKF document rather than read from the response:
        // OKF SPEC §5.3 requires the tier to be derived and never stored.
        trust_tier: trustTier(payload.okf),
        status: payload.status,
        request_id: payload.request_id,
        trace_id: payload.trace_id,
        leak_check: payload.attestation.ok ? 'pass' : 'fail',
        withheld: payload.attestation.withheld ?? [],
        findings: payload.attestation.findings ?? [],
      });
    },
  );

  server.registerTool(
    'pgw_evidence',
    {
      title: 'Fetch the stored audit document',
      description:
        'Fetch the stored OKF v0.2 audit document for one request id. The body holds the ' +
        'MASKED answer, not the rehydrated one — the rehydrated text is returned once, in ' +
        'the original response, and is never persisted. Use this to show provenance: what ' +
        'was sent, which model answered, and what the leak check concluded. ' +
        NO_RETRY_NOTE,
      inputSchema: {
        request_id: z.string().min(1).describe('The request id returned by pgw_ask.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id }) => {
      const result = await client.evidence(request_id);
      if (!result.ok) return refusal(result);

      return jsonContent({
        refused: false,
        request_id,
        trust_tier: trustTier(result.value),
        okf: result.value,
      });
    },
  );

  server.registerTool(
    'pgw_verify',
    {
      title: 'Replay an answer’s attestation',
      description:
        'Independently replay the leak check for one request: re-hash the masked artifacts ' +
        'the gateway serves, compare every digest the document records, and re-derive the ' +
        'verdict with a transcribed copy of the scanner rather than the fleet’s own code. ' +
        'Returns a per-digest verdict list. Two digests (attester_sha256, ' +
        'computation_sha256) name files in the fleet repository and are reported as ' +
        'not-checked rather than passed. ' +
        NO_RETRY_NOTE,
      inputSchema: {
        request_id: z.string().min(1).describe('The request id to replay.'),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ request_id }) => {
      const result = await verify(client, request_id);
      if (!result.ok) return refusal(result);
      return jsonContent({ refused: false, ...result.value });
    },
  );

  return server;
}
