/**
 * OpenTelemetry tracing shared by all three agents.
 *
 * One user request produces one trace spanning gateway → core → synthesis. That
 * only holds if the W3C `traceparent` header survives every hop, so the helpers
 * here are built around injecting and extracting it explicitly rather than
 * relying on auto-instrumentation, which would not cover the A2A JSON-RPC body
 * or the Cloud Run `X-Cloud-Trace-Context` header.
 *
 * Exporter selection:
 *   - production (`OTEL_ENABLED` + a GCP project) … Cloud Trace
 *   - local (`OTEL_ENABLED` alone) … console
 *   - otherwise … no exporter; spans are still created so `trace_id` appears in
 *     logs and tests can observe the tree with an in-memory exporter
 */

import {
  context,
  propagation,
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { createRequire } from 'node:module';
import type { AgentName } from './config.ts';

/** Header carrying the W3C trace context between services. */
export const TRACEPARENT_HEADER = 'traceparent';
/** Cloud Run's own trace header, used when no `traceparent` is present. */
export const CLOUD_TRACE_HEADER = 'x-cloud-trace-context';
/** Header carrying the request correlation id. */
export const REQUEST_ID_HEADER = 'x-request-id';

/** Span names, fixed so the log guide and dashboards can rely on them. */
export const SPAN = {
  request: 'request',
  maskRegex: 'mask.regex',
  maskGemma: 'mask.gemma',
  guardEgress: 'guard.egress',
  a2aCore: 'a2a.core',
  synthesisCall: 'synthesis.call',
  a2aReceive: 'a2a.receive',
  llmGemini: 'llm.gemini',
  attestLeakCheck: 'attest.leak_check',
  judgeGemma: 'judge.gemma',
  rehydrate: 'rehydrate',
  okfBuild: 'okf.build',
  persist: 'persist',
} as const;

const TRACER_NAME = 'privacy-gateway';

let provider: NodeTracerProvider | undefined;

export interface TelemetryOptions {
  readonly agent: AgentName;
  readonly enabled?: boolean | undefined;
  readonly project?: string | undefined;
  readonly serviceName?: string | undefined;
  /** Explicit exporter; the E2E test injects an in-memory one. */
  readonly exporter?: SpanExporter | undefined;
  /** Called when the exporter itself fails, logged as `otel.export.error`. */
  readonly onExportError?: ((error: unknown) => void) | undefined;
}

/**
 * Initialise tracing for this process. Safe to call once per service at boot.
 *
 * Why a provider even when disabled? `trace.getActiveSpan()` must return a real
 * span context so log lines carry `trace_id` in every environment; a no-op
 * provider would leave local logs uncorrelated.
 */
export function initTelemetry(options: TelemetryOptions): NodeTracerProvider {
  if (provider !== undefined) return provider;

  const spanProcessors: SpanProcessor[] = [];
  const exporter = options.exporter ?? resolveExporter(options);
  if (exporter !== undefined) {
    // A simple processor is used for the injected (test/console) exporters so
    // spans are visible immediately; batching only pays off for the network one.
    spanProcessors.push(
      options.exporter !== undefined
        ? new SimpleSpanProcessor(options.exporter)
        : new BatchSpanProcessor(exporter),
    );
  }

  provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName ?? `${options.agent}-agent`,
      [ATTR_SERVICE_VERSION]: '0.1.0',
    }),
    spanProcessors,
  });

  // `register()` installs the AsyncLocalStorage context manager as well as the
  // provider. Without it `context.with` would not propagate the active span
  // across an await, and every child span would start a new trace.
  //
  // Registration is a no-op once something is registered, so the previous one is
  // cleared first. In a service this runs once at boot; in tests it is what lets
  // each case install its own in-memory exporter.
  trace.disable();
  propagation.disable();
  context.disable();
  provider.register({ propagator: new W3CTraceContextPropagator() });
  return provider;
}

/** Resolve the exporter for the current environment, or none. */
function resolveExporter(options: TelemetryOptions): SpanExporter | undefined {
  if (options.enabled !== true) return undefined;

  if (options.project !== undefined && options.project !== '') {
    try {
      // Loaded lazily and synchronously: the Cloud Trace exporter pulls in gRPC
      // and auth, which a local run has no use for, and `initTelemetry` must stay
      // synchronous so a service can trace its own startup.
      const requireFrom = createRequire(import.meta.url);
      const { TraceExporter } = requireFrom('@google-cloud/opentelemetry-cloud-trace-exporter') as {
        TraceExporter: new (config: { projectId?: string }) => SpanExporter;
      };
      return new TraceExporter({ projectId: options.project });
    } catch (error) {
      options.onExportError?.(error);
      return new ConsoleSpanExporter();
    }
  }
  return new ConsoleSpanExporter();
}

/** Flush pending spans; call before a process exits. */
export async function shutdownTelemetry(): Promise<void> {
  if (provider === undefined) return;
  await provider.shutdown();
  provider = undefined;
}

/** Reset module state. Test-only. */
export function resetTelemetryForTests(): void {
  provider = undefined;
}

export function getTracer(): Tracer {
  return trace.getTracer(TRACER_NAME);
}

/**
 * Re-exported so a consumer can hold a span handle without a direct dependency
 * on @opentelemetry/api — Core, whose package graph is deliberately minimal,
 * does exactly this.
 *
 * Renamed because `schema.ts` already exports a `Span`: a detected PII span.
 * Two unrelated things called Span in one barrel would be a trap.
 */
export type { Span as TraceSpan, Tracer } from '@opentelemetry/api';

/**
 * Run `fn` inside a span, recording the failure class and always ending the span.
 *
 * Attributes must never carry PII values — only counts, categories, verdicts and
 * identifiers.
 *
 * Why not `span.recordException(error)`: it copies `exception.message` and
 * `exception.stacktrace` onto the span verbatim, and an exception message
 * routinely embeds the value that caused it (a response body, a prompt
 * fragment). The class name and an optional `code` locate the throw site just as
 * well, and the request id in the correlated log line does the rest.
 */
export async function withSpan<T>(
  name: string,
  attributes: Attributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tracer = getTracer();
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const errorClass = error instanceof Error ? error.name : 'unknown_error';
      const code = (error as { code?: unknown } | null)?.code;
      span.setAttribute('error.class', errorClass);
      if (typeof code === 'string' || typeof code === 'number') {
        span.setAttribute('error.code', String(code));
      }
      // The status message is the class, not the exception text.
      span.setStatus({ code: SpanStatusCode.ERROR, message: errorClass });
      throw error;
    } finally {
      span.end();
    }
  });
}

/** The active trace id, or undefined when no span is recording. */
export function currentTraceId(): string | undefined {
  const span = trace.getActiveSpan();
  const traceId = span?.spanContext().traceId;
  // An all-zero id is the invalid context OpenTelemetry returns when unsampled.
  return traceId === undefined || /^0+$/u.test(traceId) ? undefined : traceId;
}

/**
 * Rebuild the parent context from inbound headers.
 *
 * `traceparent` wins when present. Cloud Run always sets
 * `X-Cloud-Trace-Context` (`TRACE_ID/SPAN_ID;o=1`), so it is translated into a
 * traceparent as a fallback — without it, every Cloud Run request would start a
 * new trace and the fleet-wide view would break.
 */
export function contextFromHeaders(headers: Readonly<Record<string, string | undefined>>): Context {
  const normalized: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) normalized[key.toLowerCase()] = value;
  }

  if (normalized[TRACEPARENT_HEADER] !== undefined) {
    return propagation.extract(ROOT_CONTEXT, normalized);
  }

  const cloudTrace = normalized[CLOUD_TRACE_HEADER];
  if (cloudTrace !== undefined) {
    const synthetic = traceparentFromCloudTrace(cloudTrace);
    if (synthetic !== undefined) {
      return propagation.extract(ROOT_CONTEXT, { [TRACEPARENT_HEADER]: synthetic });
    }
  }

  return ROOT_CONTEXT;
}

/** Translate `TRACE_ID/SPAN_ID;o=1` into a W3C traceparent. */
export function traceparentFromCloudTrace(value: string): string | undefined {
  const match = /^([0-9a-fA-F]{32})\/(\d+)(?:;o=([01]))?/u.exec(value.trim());
  if (match === null) return undefined;
  const [, traceId, spanDecimal, sampled] = match;
  if (traceId === undefined || spanDecimal === undefined) return undefined;

  // Cloud Trace reports the span id in decimal; W3C wants 16 hex digits.
  const spanId = BigInt(spanDecimal).toString(16).padStart(16, '0').slice(-16);
  const flags = sampled === '0' ? '00' : '01';
  return `00-${traceId.toLowerCase()}-${spanId}-${flags}`;
}

/** Headers that propagate the active trace to the next hop. */
export function outboundTraceHeaders(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Run `fn` with `ctx` active, so spans created inside attach to that parent. */
export function withContext<T>(ctx: Context, fn: () => T): T {
  return context.with(ctx, fn);
}
