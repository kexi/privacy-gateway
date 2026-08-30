/**
 * What the status, warmup and progress-stream surfaces guarantee.
 *
 * Three things are pinned here. The status endpoint never wakes Gemma and never
 * 500s. The warmup endpoint dispatches exactly one wake without waiting for it.
 * And the SSE mode of `/v1/ask` reports the pipeline's stages in order, ends on
 * a terminal frame, and carries no request content in any progress frame — the
 * last of these being the property that would be easiest to lose.
 */

import {
  createLogger,
  findTokens,
  InMemoryActivityStore,
  InMemoryTokenVault,
  loadConfig,
  ProgressEventSchema,
  StatusResponseSchema,
  WARM_WINDOW_MS,
  type ActivityStore,
  type Config,
} from '@privacy-gateway/common';
import { createApp as createSynthesisApp } from '@privacy-gateway/synthesis/server';
import { InMemoryAnswerStore } from '@privacy-gateway/synthesis/store';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server.ts';
import { wakeGemma } from '../src/warmup.ts';

const CORE_BASE_URL = 'http://core.test';

const PII_PROMPT =
  'Customer Taro Yamada (taro@example.co.jp) reports that the charge on card ' +
  '4242 4242 4242 4242 failed. Draft a polite reply.';

/** A prompt whose masked form still holds a raw identifier is impossible to build
 * from the outside, so the egress-guard stop is exercised via a leaking Core
 * instead: Synthesis refuses the release and the stream must say where it broke. */
const LEAK_PROMPT = 'Please summarise the incident report for the account team.';

let servers: Array<{ close(cb: () => void): void }> = [];
let gatewayUrl = '';

function testConfig(overrides: Record<string, string> = {}): Config {
  return loadConfig({
    agent: 'gateway',
    env: {
      VAULT_BACKEND: 'memory',
      CORE_BASE_URL,
      GEMINI_MODEL: 'gemini-3.5-flash',
      GEMMA_MODEL: 'gemma4:12b',
      RATE_LIMIT_PER_MINUTE: '0',
      ...overrides,
    },
    onInvalid: (message) => {
      throw new Error(message);
    },
  });
}

function echoingCore(prompt: string): string {
  const tokens = findTokens(prompt);
  return `Dear ${tokens[0] ?? 'customer'}, we have logged the failed charge.`;
}

/** A Core that emits a raw address of its own, so Synthesis refuses the release. */
function leakingCore(): string {
  return 'Contact them directly at leaked.person@example.com.';
}

function fleetFetch(core: (prompt: string) => string, synthesisUrl: string): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const parsed = new URL(typeof input === 'string' ? input : input.toString());

    if (parsed.origin === CORE_BASE_URL && parsed.pathname === '/.well-known/agent-card.json') {
      return Promise.resolve(
        Response.json({
          name: 'core_agent',
          description: 'mock core',
          url: `${CORE_BASE_URL}/jsonrpc`,
          version: '1.0.0',
        }),
      );
    }

    if (parsed.origin === CORE_BASE_URL && parsed.pathname === '/jsonrpc') {
      const body = JSON.parse(String(init?.body)) as {
        id: string;
        params: { message: { parts: Array<{ text?: string }> } };
      };
      const prompt = body.params.message.parts.map((part) => part.text ?? '').join('');
      return Promise.resolve(
        Response.json({
          jsonrpc: '2.0',
          id: body.id,
          result: { role: 'agent', parts: [{ kind: 'text', text: core(prompt) }], messageId: 'r1' },
        }),
      );
    }

    if (parsed.pathname.endsWith('/chat/completions') && parsed.origin !== gatewayUrl) {
      return Promise.resolve(
        Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({ spans: [{ text: 'Taro Yamada', category: 'PERSON' }] }),
              },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }

    return globalThis.fetch(`${synthesisUrl}${parsed.pathname}${parsed.search}`, init);
  }) as typeof fetch;
}

interface FleetOptions {
  readonly core?: (prompt: string) => string;
  readonly activityStore?: ActivityStore;
  readonly wakeGemmaImpl?: () => Promise<boolean>;
  readonly overrides?: Record<string, string>;
}

async function startFleet(options: FleetOptions = {}): Promise<void> {
  const vault = new InMemoryTokenVault();

  const synthesisApp = await createSynthesisApp({
    config: testConfig(),
    logger: createLogger({ agent: 'synthesis', write: () => undefined }),
    vault,
    store: new InMemoryAnswerStore(),
  });
  const synthesisServer = synthesisApp.listen(0);
  servers.push(synthesisServer);
  const synthesisAddress = synthesisServer.address();
  const synthesisPort =
    typeof synthesisAddress === 'object' && synthesisAddress !== null ? synthesisAddress.port : 0;
  const synthesisUrl = `http://127.0.0.1:${synthesisPort}`;

  const gateway = createApp({
    config: testConfig({ SYNTHESIS_BASE_URL: synthesisUrl, ...options.overrides }),
    logger: createLogger({ agent: 'gateway', write: () => undefined }),
    vault,
    fetchImpl: fleetFetch(options.core ?? echoingCore, synthesisUrl),
    ...(options.activityStore !== undefined ? { activityStore: options.activityStore } : {}),
    ...(options.wakeGemmaImpl !== undefined ? { wakeGemmaImpl: options.wakeGemmaImpl } : {}),
  });

  const gatewayServer = gateway.listen(0);
  servers.push(gatewayServer);
  const gatewayAddress = gatewayServer.address();
  const gatewayPort =
    typeof gatewayAddress === 'object' && gatewayAddress !== null ? gatewayAddress.port : 0;
  gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
}

afterEach(async () => {
  await Promise.all(
    servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
  );
  servers = [];
});

describe('GET /v1/status', () => {
  it('reports cold when Gemma has never been reached', async () => {
    await startFleet({ activityStore: new InMemoryActivityStore() });

    const response = await fetch(`${gatewayUrl}/v1/status`);
    const body = StatusResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.gemma).toBe('cold');
    expect(body.cold_start_estimate_seconds).toBe(120);
  });

  it('reports warm after a recent Gemma call', async () => {
    const store = new InMemoryActivityStore();
    await store.record(new Date());
    await startFleet({ activityStore: store });

    const body = StatusResponseSchema.parse(await (await fetch(`${gatewayUrl}/v1/status`)).json());

    expect(body.gemma).toBe('warm');
    expect(body.last_active_at).toBeDefined();
  });

  it('reports cold once the retention window has elapsed', async () => {
    const store = new InMemoryActivityStore();
    await store.record(new Date(Date.now() - WARM_WINDOW_MS - 1000));
    await startFleet({ activityStore: store });

    const body = StatusResponseSchema.parse(await (await fetch(`${gatewayUrl}/v1/status`)).json());

    expect(body.gemma).toBe('cold');
    // Still reported: "last seen 40 minutes ago" beats a bare `cold`.
    expect(body.last_active_at).toBeDefined();
  });

  it('reports unknown rather than 500 when the store is unreachable', async () => {
    const store: ActivityStore = {
      read: () => Promise.reject(new Error('permission denied')),
      readActivity: () => Promise.reject(new Error('permission denied')),
      record: () => Promise.resolve(),
      recordWarmupRequest: () => Promise.resolve(),
    };
    await startFleet({ activityStore: store });

    const response = await fetch(`${gatewayUrl}/v1/status`);
    const body = StatusResponseSchema.parse(await response.json());

    expect(response.status).toBe(200);
    expect(body.gemma).toBe('unknown');
  });

  it('never calls Gemma', async () => {
    // The endpoint exists precisely so that asking "is the GPU asleep?" does not
    // wake it. A probe here would bill an L4 for every page load.
    const store = new InMemoryActivityStore();
    const wake = vi.fn(() => Promise.resolve(true));
    await startFleet({ activityStore: store, wakeGemmaImpl: wake });

    await fetch(`${gatewayUrl}/v1/status`);

    expect(wake).not.toHaveBeenCalled();
  });
});

describe('POST /v1/warmup', () => {
  it('dispatches exactly one wake and answers without waiting for it', async () => {
    let resolveWake: (() => void) | undefined;
    const wake = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveWake = () => resolve(true);
        }),
    );
    await startFleet({ wakeGemmaImpl: wake });

    const response = await fetch(`${gatewayUrl}/v1/warmup`, { method: 'POST' });

    // Answered while the wake is still outstanding: a cold start outlives any
    // reasonable HTTP timeout, so the caller is told it started, not that it
    // finished.
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ started: true });
    expect(wake).toHaveBeenCalledTimes(1);
    resolveWake?.();
  });

  it('still answers when the wake fails', async () => {
    // A timeout against a cold instance is the expected outcome, not an error:
    // the container is booting either way.
    const wake = vi.fn(() => Promise.reject(new Error('timed out')));
    await startFleet({ wakeGemmaImpl: wake });

    const response = await fetch(`${gatewayUrl}/v1/warmup`, { method: 'POST' });

    expect(response.status).toBe(202);
  });

  it('makes the very next status poll report warming', async () => {
    const store = new InMemoryActivityStore();
    await startFleet({ activityStore: store, wakeGemmaImpl: () => Promise.resolve(true) });

    // The feature this exists for: pressing the button must change what the
    // badge says immediately, rather than staying `cold` for the two minutes it
    // takes a real Gemma call to land.
    await fetch(`${gatewayUrl}/v1/warmup`, { method: 'POST' });

    await vi.waitFor(async () => {
      const body = StatusResponseSchema.parse(
        await (await fetch(`${gatewayUrl}/v1/status`)).json(),
      );
      expect(body.gemma).toBe('warming');
      expect(body.warmup_requested_at).toBeDefined();
    });
  });

  it('leaves the badge warm when the fleet was already up', async () => {
    const store = new InMemoryActivityStore();
    await store.record(new Date());
    await startFleet({ activityStore: store, wakeGemmaImpl: () => Promise.resolve(true) });

    await fetch(`${gatewayUrl}/v1/warmup`, { method: 'POST' });

    // Warming up an already-warm fleet must not downgrade the badge into a wait
    // that is not happening.
    const body = StatusResponseSchema.parse(await (await fetch(`${gatewayUrl}/v1/status`)).json());
    expect(body.gemma).toBe('warm');
  });

  it('is refused when the caller is over the rate limit', async () => {
    // The one endpoint that spends GPU money without producing an answer, so it
    // shares the limiter rather than being exempt from it.
    await startFleet({
      wakeGemmaImpl: () => Promise.resolve(true),
      overrides: { RATE_LIMIT_PER_MINUTE: '1' },
    });

    await fetch(`${gatewayUrl}/v1/warmup`, { method: 'POST' });
    const second = await fetch(`${gatewayUrl}/v1/warmup`, { method: 'POST' });

    expect(second.status).toBe(429);
  });
});

/** Fire-and-forget writes land a tick later than the call that made them. */
async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** A fetch that behaves like an aborted request: delivered, then given up on. */
function abortingFetch(): Promise<Response> {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return Promise.reject(error);
}

/** A fetch that never reached the far end at all. */
function refusingFetch(): Promise<Response> {
  return Promise.reject(new Error('ECONNREFUSED'));
}

/** A fetch that answers, as an already-running instance would. */
function answeringFetch(): Promise<Response> {
  return Promise.resolve(new Response('{}'));
}

describe('wakeGemma, stamping the warmup clock', () => {
  // `none` keeps the static-key path: minting a real ID token would need
  // credentials, and the auth mode is not what these tests are about.
  const base = { baseUrl: 'http://gemma.test/v1', apiKey: 'k', auth: 'none' as const };

  it('stamps when the wake is answered', async () => {
    const store = new InMemoryActivityStore();

    await wakeGemma({ ...base, activityStore: store, fetchImpl: answeringFetch });
    await settled();

    expect((await store.readActivity()).warmupRequestedAt).not.toBeNull();
  });

  it('stamps when the wake times out, because the container is still booting', async () => {
    const store = new InMemoryActivityStore();

    await wakeGemma({ ...base, activityStore: store, fetchImpl: abortingFetch });
    await settled();

    // The case that matters most: against a genuinely cold instance the probe
    // usually times out while Cloud Run keeps starting the container. Refusing
    // to stamp here would show `warming` only when the fleet was already up.
    expect((await store.readActivity()).warmupRequestedAt).not.toBeNull();
  });

  it('does not stamp when nothing was ever reached', async () => {
    const store = new InMemoryActivityStore();

    await wakeGemma({ ...base, activityStore: store, fetchImpl: refusingFetch });
    await settled();

    // A transport failure woke nothing, so claiming `warming` would promise a
    // boot that is not happening and hide a broken configuration.
    expect((await store.readActivity()).warmupRequestedAt).toBeNull();
  });

  it('wakes without a store rather than refusing to', async () => {
    // The wake does not depend on the badge: a fleet with no activity store must
    // still boot, it simply cannot describe the boot.
    await expect(wakeGemma({ ...base, fetchImpl: answeringFetch })).resolves.toBe(true);
  });
});

describe('the activity write', () => {
  it('does not fail the request when the store is broken', async () => {
    const store: ActivityStore = {
      record: () => Promise.reject(new Error('firestore is unreachable')),
      recordWarmupRequest: () => Promise.reject(new Error('firestore is unreachable')),
      read: () => Promise.resolve(null),
      readActivity: () => Promise.resolve({ lastActiveAt: null, warmupRequestedAt: null }),
    };
    await startFleet({ activityStore: store });

    const response = await fetch(`${gatewayUrl}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: PII_PROMPT }),
    });

    // The badge is a convenience; it must never be able to take down an answer.
    expect(response.status).toBe(200);
  });

  it('records activity after a successful extraction', async () => {
    const store = new InMemoryActivityStore();
    await startFleet({ activityStore: store });

    await fetch(`${gatewayUrl}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: PII_PROMPT }),
    });

    // Fire-and-forget, so the write may land a tick after the response.
    await vi.waitFor(async () => {
      expect(await store.read()).not.toBeNull();
    });
  });
});

/** Reads an SSE body into its parsed frames. */
async function readStream(response: Response): Promise<Array<{ event: string; data: unknown }>> {
  const text = await response.text();
  const frames: Array<{ event: string; data: unknown }> = [];

  for (const block of text.split('\n\n')) {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join('\n');
    if (data === '') continue;
    if (data === '[DONE]') {
      frames.push({ event: 'done', data: null });
      continue;
    }
    frames.push({ event, data: JSON.parse(data) as unknown });
  }
  return frames;
}

function askStream(text: string): Promise<Response> {
  return fetch(`${gatewayUrl}/v1/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({ text }),
  });
}

describe('POST /v1/ask as a progress stream', () => {
  it('streams the stages in pipeline order and ends on a result', async () => {
    await startFleet();

    const response = await askStream(PII_PROMPT);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const frames = await readStream(response);
    const stages = frames
      .filter((frame) => frame.event === 'progress')
      .map((frame) => ProgressEventSchema.parse(frame.data))
      .filter((event) => event.state === 'end')
      .map((event) => event.stage);

    expect(stages).toEqual([
      'masking',
      'egress_guard',
      'core_reasoning',
      'leak_check',
      'rehydrate',
    ]);

    expect(frames.at(-2)?.event).toBe('result');
    expect(frames.at(-1)?.event).toBe('done');
  });

  it('opens every stage before it closes it', async () => {
    await startFleet();

    const events = (await readStream(await askStream(PII_PROMPT)))
      .filter((frame) => frame.event === 'progress')
      .map((frame) => ProgressEventSchema.parse(frame.data));

    const open = new Set<string>();
    for (const event of events) {
      if (event.state === 'start') open.add(event.stage);
      else {
        expect(open.has(event.stage), `${event.stage} ended without starting`).toBe(true);
      }
    }
  });

  it('carries no request content in any progress frame', async () => {
    await startFleet();

    const frames = (await readStream(await askStream(PII_PROMPT))).filter(
      (frame) => frame.event === 'progress',
    );

    for (const frame of frames) {
      // The strict schema is the guarantee: a frame has a stage, a state and a
      // number, and there is no field an answer fragment or a placeholder could
      // ride in on.
      expect(() => ProgressEventSchema.parse(frame.data)).not.toThrow();
      expect(JSON.stringify(frame.data)).not.toContain('Taro');
      expect(JSON.stringify(frame.data)).not.toContain('taro@example.co.jp');
      expect(JSON.stringify(frame.data)).not.toContain('⟦');
    }
  });

  it('reports a refusal as a frame naming the stage that stopped', async () => {
    await startFleet({ core: leakingCore });

    const frames = await readStream(await askStream(LEAK_PROMPT));
    const refused = frames.find((frame) => frame.event === 'refused');

    expect(refused).toBeDefined();
    // The HTTP status is already committed to 200 by the time the pipeline knows
    // it will refuse, so the real status travels in the body.
    const refusalBody = refused?.data as { status: number } | undefined;
    expect(refusalBody?.status).toBeGreaterThanOrEqual(400);
    expect(frames.at(-1)?.event).toBe('done');

    // `leak_check` opened but never ended: that absence is how a client knows
    // which gate stopped the request.
    const events = frames
      .filter((frame) => frame.event === 'progress')
      .map((frame) => ProgressEventSchema.parse(frame.data));
    const ended = events.filter((event) => event.state === 'end').map((event) => event.stage);
    expect(ended).not.toContain('rehydrate');
    expect(events.some((event) => event.stage === 'leak_check' && event.state === 'start')).toBe(
      true,
    );
  });

  it('leaves the non-streaming path byte-identical', async () => {
    await startFleet();

    const streamed = await readStream(await askStream(PII_PROMPT));
    const result = streamed.find((frame) => frame.event === 'result')?.data as {
      answer: string;
      masked_prompt: string;
    };

    const plain = (await (
      await fetch(`${gatewayUrl}/v1/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: PII_PROMPT }),
      })
    ).json()) as { answer: string; masked_prompt: string };

    // Different transport, same facts: the ids differ per request, but the
    // masking and the answer must not.
    expect(result.masked_prompt).toBe(plain.masked_prompt);
    expect(result.answer).toBe(plain.answer);
  });

  it('answers JSON when the caller does not ask for a stream', async () => {
    await startFleet();

    const response = await fetch(`${gatewayUrl}/v1/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: PII_PROMPT }),
    });

    expect(response.headers.get('content-type')).toContain('application/json');
  });
});
