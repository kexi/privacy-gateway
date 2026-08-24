/**
 * Thin client for the Gateway API.
 *
 * Every type here is derived from the zod schemas in `@privacy-gateway/common`,
 * the same definitions the Gateway validates against, so the UI cannot drift
 * from the server's contract without a type error. Responses are parsed, not
 * cast: a shape change surfaces at the boundary rather than as an undefined
 * halfway through rendering.
 */

import {
  AskResponseSchema,
  ErrorResponseSchema,
  GatewayAnswerFrontmatterSchema,
  type AskResponse,
  type Attestation,
  type ConsistencyReport,
  type TrustDimensions,
  type TrustTier,
  type VerificationEvent,
} from '@privacy-gateway/common/schema';
import { parse as parseYaml } from 'yaml';

export type {
  AskResponse,
  Attestation,
  ConsistencyReport,
  TrustDimensions,
  TrustTier,
  VerificationEvent,
};

export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | undefined;
  readonly categories: readonly string[] | undefined;

  constructor(message: string, status: number, requestId?: string, categories?: readonly string[]) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.requestId = requestId;
    this.categories = categories;
  }
}

async function request<T>(
  path: string,
  parse: (value: unknown) => T,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  if (!response.ok) {
    throw await toApiError(response);
  }
  return parse(await response.json());
}

/** Turns an error body into an ApiError, keeping the request id for support. */
async function toApiError(response: Response): Promise<ApiError> {
  const requestId = response.headers.get('x-request-id') ?? undefined;

  try {
    const parsed = ErrorResponseSchema.safeParse(await response.json());
    if (parsed.success) {
      const { error, message, categories } = parsed.data;
      const detail = categories?.length ? ` (${categories.join(', ')})` : '';
      return new ApiError(
        `${message ?? error}${detail}`,
        response.status,
        parsed.data.request_id ?? requestId,
        categories,
      );
    }
  } catch {
    // Falls through to the generic message below.
  }
  return new ApiError(`request failed with status ${response.status}`, response.status, requestId);
}

/**
 * Send one request.
 *
 * There is no session parameter: the gateway mints one id per request and
 * rejects a body that carries `session_id` at all.
 */
export function ask(text: string): Promise<AskResponse> {
  return request('/v1/ask', (value) => AskResponseSchema.parse(value), {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

/** Fetch the stored masked OKF evidence document for one request. */
export async function evidence(requestId: string): Promise<string> {
  const response = await fetch(`/v1/requests/${encodeURIComponent(requestId)}`);
  if (!response.ok) throw await toApiError(response);
  return response.text();
}

/**
 * Derive the trust tier from the OKF frontmatter `verified` field (SPEC §5.3).
 *
 * The UI derives this rather than displaying the server's value so that the tier
 * stays a value computed on the spot, not one that is stored — mirroring in the
 * UI the property the specification requires.
 */
export function deriveTrustTier(verified: readonly VerificationEvent[] | undefined): TrustTier {
  if (verified === undefined || verified.length === 0) return 'unverified';
  return verified.some((entry) => entry.by.startsWith('human:'))
    ? 'human-reviewed'
    : 'machine-confirmed';
}

/** Lifts the `verified` entries out of an OKF document's frontmatter. */
export function extractVerified(okf: string): VerificationEvent[] {
  const metadata = parseFrontmatter(okf);
  if (metadata === null) return [];

  const parsed = GatewayAnswerFrontmatterSchema.safeParse(metadata);
  if (!parsed.success) return [];

  const verified = parsed.data.verified;
  if (verified === undefined) return [];
  // SPEC §5.2: a bare mapping is treated as a one-element list.
  return Array.isArray(verified) ? verified : [verified];
}

/** Reads the frontmatter of an OKF document, or null when there is none. */
export function parseFrontmatter(okf: string): Record<string, unknown> | null {
  const match = /^---\n([\s\S]*?)\n---/u.exec(okf);
  if (match?.[1] === undefined) return null;

  try {
    const loaded: unknown = parseYaml(match[1]);
    return loaded !== null && typeof loaded === 'object' && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : null;
  } catch {
    // §11: a malformed field must not make the document unreadable.
    return null;
  }
}

/** Cloud Trace link for one trace, shown next to the trace id. */
export function traceConsoleUrl(traceId: string, project: string): string {
  return `https://console.cloud.google.com/traces/list?project=${encodeURIComponent(project)}&tid=${encodeURIComponent(traceId)}`;
}

/** Logs Explorer link filtered to one request. */
export function logsConsoleUrl(requestId: string, project: string): string {
  const query = encodeURIComponent(`jsonPayload.request_id="${requestId}"`);
  return `https://console.cloud.google.com/logs/query;query=${query}?project=${encodeURIComponent(project)}`;
}
