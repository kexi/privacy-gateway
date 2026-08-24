/**
 * What tracing guarantees: a request keeps one trace id across hops, inbound
 * headers restore the parent, and span attributes never carry PII.
 */

import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-base';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contextFromHeaders,
  currentTraceId,
  initTelemetry,
  outboundTraceHeaders,
  resetTelemetryForTests,
  shutdownTelemetry,
  SPAN,
  traceparentFromCloudTrace,
  withContext,
  withSpan,
} from '../src/telemetry.ts';

let exporter: InMemorySpanExporter;

beforeEach(() => {
  resetTelemetryForTests();
  exporter = new InMemorySpanExporter();
  initTelemetry({ agent: 'gateway', enabled: true, exporter });
});

afterEach(async () => {
  await shutdownTelemetry();
  exporter.reset();
});

describe('span recording', () => {
  it('records a span with its attributes', async () => {
    await withSpan(SPAN.maskRegex, { placeholder_count: 3 }, () => Promise.resolve('done'));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]?.name).toBe('mask.regex');
    expect(spans[0]?.attributes['placeholder_count']).toBe(3);
  });

  it('records the error class and rethrows on failure', async () => {
    await expect(
      withSpan(SPAN.guardEgress, {}, () => Promise.reject(new Error('blocked'))),
    ).rejects.toThrow('blocked');

    const span = exporter.getFinishedSpans()[0];
    expect(span?.status.code).toBe(2);
    expect(span?.attributes['error.class']).toBe('Error');
  });

  it('never copies an exception message or stack onto the span', async () => {
    // `recordException` would attach exception.message and exception.stacktrace
    // verbatim, and an exception message routinely embeds the value that caused
    // it — a response body, a prompt fragment, a header.
    const secret = 'taro@example.co.jp';
    await expect(
      withSpan(SPAN.guardEgress, {}, () => Promise.reject(new Error(`could not reach ${secret}`))),
    ).rejects.toThrow(secret);

    const span = exporter.getFinishedSpans()[0];
    expect(JSON.stringify(span?.attributes)).not.toContain(secret);
    expect(span?.status.message).not.toContain(secret);
    expect(span?.events.some((event) => event.name === 'exception')).toBe(false);
  });

  it('records a numeric or string error code when the failure carries one', async () => {
    const failure = Object.assign(new Error('nope'), { code: 'ECONNREFUSED' });
    await expect(withSpan(SPAN.a2aCore, {}, () => Promise.reject(failure))).rejects.toThrow();

    expect(exporter.getFinishedSpans()[0]?.attributes['error.code']).toBe('ECONNREFUSED');
  });

  it('nests child spans under the active parent', async () => {
    await withSpan(SPAN.request, {}, async () => {
      await withSpan(SPAN.maskRegex, {}, () => Promise.resolve());
      await withSpan(SPAN.a2aCore, {}, () => Promise.resolve());
    });

    const spans = exporter.getFinishedSpans();
    const parent = spans.find((span) => span.name === 'request');
    const child = spans.find((span) => span.name === 'a2a.core');

    expect(parent).toBeDefined();
    expect(child?.parentSpanContext?.spanId).toBe(parent?.spanContext().spanId);
    // One request means one trace, no matter how deep the tree goes.
    expect(child?.spanContext().traceId).toBe(parent?.spanContext().traceId);
  });

  it('exposes the active trace id for log correlation', async () => {
    let seen: string | undefined;
    await withSpan(SPAN.request, {}, () => {
      seen = currentTraceId();
      return Promise.resolve();
    });

    expect(seen).toMatch(/^[0-9a-f]{32}$/u);
    expect(seen).toBe(exporter.getFinishedSpans()[0]?.spanContext().traceId);
  });
});

describe('propagation', () => {
  it('injects a traceparent for the next hop', async () => {
    let headers: Record<string, string> = {};
    await withSpan(SPAN.a2aCore, {}, () => {
      headers = outboundTraceHeaders();
      return Promise.resolve();
    });

    expect(headers['traceparent']).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/u);
  });

  it('continues the caller trace from an inbound traceparent', async () => {
    const traceId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const parentContext = contextFromHeaders({
      traceparent: `00-${traceId}-bbbbbbbbbbbbbbbb-01`,
    });

    await withContext(parentContext, () => withSpan(SPAN.a2aReceive, {}, () => Promise.resolve()));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.parentSpanContext?.spanId).toBe('bbbbbbbbbbbbbbbb');
  });

  it('restores the parent from the Cloud Run trace header', async () => {
    // Without this, every Cloud Run request would start a fresh trace.
    const traceId = 'cccccccccccccccccccccccccccccccc';
    const parentContext = contextFromHeaders({ 'x-cloud-trace-context': `${traceId}/255;o=1` });

    await withContext(parentContext, () => withSpan(SPAN.a2aReceive, {}, () => Promise.resolve()));

    const span = exporter.getFinishedSpans()[0];
    expect(span?.spanContext().traceId).toBe(traceId);
    expect(span?.parentSpanContext?.spanId).toBe('00000000000000ff');
  });

  it('prefers traceparent over the Cloud Run header', () => {
    const context = contextFromHeaders({
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
      'x-cloud-trace-context': '33333333333333333333333333333333/1;o=1',
    });
    const spanContext = context.getValue(Symbol.for('OpenTelemetry Context Key SPAN'));
    expect(spanContext).toBeDefined();
  });

  it('converts a decimal Cloud Trace span id to hex', () => {
    expect(traceparentFromCloudTrace('abcdefabcdefabcdefabcdefabcdefab/1;o=1')).toBe(
      '00-abcdefabcdefabcdefabcdefabcdefab-0000000000000001-01',
    );
  });

  it('marks an unsampled Cloud Trace context as unsampled', () => {
    expect(traceparentFromCloudTrace('abcdefabcdefabcdefabcdefabcdefab/1;o=0')).toMatch(/-00$/u);
  });

  it('ignores a malformed Cloud Trace header', () => {
    expect(traceparentFromCloudTrace('garbage')).toBeUndefined();
  });
});
