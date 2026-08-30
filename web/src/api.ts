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
  ProgressEventSchema,
  StatusResponseSchema,
  StreamRefusalSchema,
  type AskResponse,
  type Attestation,
  type ConsistencyReport,
  type GemmaWarmth,
  type ProgressEvent,
  type ProgressStage,
  type StatusResponse,
  type TrustDimensions,
  type TrustTier,
  type VerificationEvent,
} from '@privacy-gateway/common/schema';
import { parse as parseYaml } from 'yaml';

export type {
  AskResponse,
  Attestation,
  ConsistencyReport,
  GemmaWarmth,
  ProgressEvent,
  ProgressStage,
  StatusResponse,
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

/**
 * Read the fleet's warm/cold state.
 *
 * Never throws: the badge is a convenience, and a UI that surfaces a network
 * error where it meant to show a status is worse than one that shows `unknown`.
 * The server has the same rule — see `agents/gateway/src/status.ts`.
 */
export async function fleetStatus(): Promise<StatusResponse> {
  try {
    const response = await fetch('/v1/status');
    if (!response.ok) throw new Error(`status ${response.status}`);
    return StatusResponseSchema.parse(await response.json());
  } catch {
    return { gemma: 'unknown', cold_start_estimate_seconds: 120 };
  }
}

/**
 * Ask the gateway to start the GPU.
 *
 * Resolves once the request was dispatched, which is not the same as Gemma being
 * ready: the caller re-polls `status()` to find that out.
 */
export async function warmup(): Promise<void> {
  const response = await fetch('/v1/warmup', { method: 'POST' });
  if (!response.ok) throw await toApiError(response);
}

/**
 * Send one request and watch the pipeline work.
 *
 * The gateway streams a stage transition per pipeline step and finishes with the
 * same `AskResponse` the JSON path returns, so the caller ends up with identical
 * facts either way — only the waiting is narrated.
 *
 * A refusal arrives as a frame, not as an HTTP status: the response code was
 * committed to 200 before the pipeline knew it would refuse. The `refused` frame
 * carries the status it would have had, and it is rebuilt into the same
 * `ApiError` the non-streaming path throws, so callers handle one shape.
 *
 * Falls back to the plain JSON request whenever streaming is unavailable — an
 * environment without `ReadableStream`, or a gateway that ignored the `Accept`
 * header and answered with JSON anyway.
 */
export async function askStreaming(
  text: string,
  onProgress: (event: ProgressEvent) => void,
): Promise<AskResponse> {
  const response = await fetch('/v1/ask', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
  });

  if (!response.ok) throw await toApiError(response);

  const isStream = response.headers.get('content-type')?.includes('text/event-stream') === true;
  if (!isStream || response.body === null) {
    // The gateway answered the old way; parse it as the plain response so a
    // deployment mismatch degrades to "no progress" rather than to a failure.
    return AskResponseSchema.parse(await response.json());
  }

  return consumeAskStream(response.body, onProgress);
}

/** Reads the SSE frames of one `/v1/ask` stream to their terminal event. */
async function consumeAskStream(
  body: ReadableStream<Uint8Array>,
  onProgress: (event: ProgressEvent) => void,
): Promise<AskResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let result: AskResponse | undefined;
  let refusal: ApiError | undefined;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Frames are separated by a blank line. Everything before the last
      // separator is complete; the remainder stays buffered for the next chunk.
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';

      for (const frame of frames) {
        const parsed = parseFrame(frame);
        if (parsed === null) continue;
        if (parsed.event === 'progress') {
          const progress = ProgressEventSchema.safeParse(parsed.data);
          if (progress.success) onProgress(progress.data);
        } else if (parsed.event === 'result') {
          result = AskResponseSchema.parse(parsed.data);
        } else if (parsed.event === 'refused') {
          refusal = toStreamError(parsed.data);
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (refusal !== undefined) throw refusal;
  if (result !== undefined) return result;
  // The stream ended without a terminal frame: the connection dropped
  // mid-pipeline, which is a failure rather than an empty answer.
  throw new ApiError('the gateway closed the stream before answering', 502);
}

/** Splits one SSE frame into its event name and JSON payload. */
function parseFrame(frame: string): { event: string; data: unknown } | null {
  let event = 'message';
  const dataLines: string[] = [];

  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }

  const data = dataLines.join('\n');
  if (data === '' || data === '[DONE]') return null;

  try {
    return { event, data: JSON.parse(data) as unknown };
  } catch {
    // A frame that is not JSON is not something this client knows how to act on.
    return null;
  }
}

/** Rebuilds the streamed refusal into the same ApiError the JSON path throws. */
function toStreamError(payload: unknown): ApiError {
  const parsed = StreamRefusalSchema.safeParse(payload);
  if (!parsed.success) return new ApiError('the request was refused', 502);

  const { error, message, categories, request_id: requestId, status: httpStatus } = parsed.data;
  const detail = categories?.length ? ` (${categories.join(', ')})` : '';
  return new ApiError(`${message ?? error}${detail}`, httpStatus ?? 502, requestId, categories);
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
