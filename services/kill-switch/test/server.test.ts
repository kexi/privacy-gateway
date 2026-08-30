/**
 * What the push endpoint tells Pub/Sub to do next.
 *
 * The status code is the whole retry policy, so it is the part worth pinning.
 * The rule these encode: one budget notification causes at most one trip
 * attempt. A 5xx here asks for redelivery, and during the live fire that turned
 * a half-failed trip into a revoke every ~30 s for 11 minutes, which re-removed
 * the gateway's public binding seconds after each operator restore
 * (docs/proof/kill-switch.md). Delivery is therefore terminal: the endpoint
 * acknowledges even a failed trip, leaving the ERROR log and the dead-letter
 * topic as the operator's signal.
 */

import { loadConfig } from '@privacy-gateway/common/config';
import { createLogger, type Logger } from '@privacy-gateway/common/logging';
import type express from 'express';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ActionOutcome, KillActions } from '../src/actions.ts';
import { createApp } from '../src/server.ts';

/** Actions that can be told to fail, so a partial trip can be exercised. */
class StubActions implements KillActions {
  public failScale = false;
  public tripped = false;

  revokePublicInvoker(_service: string): Promise<ActionOutcome> {
    return Promise.resolve({ alreadyApplied: false });
  }

  scaleToZero(_service: string): Promise<ActionOutcome> {
    if (this.failScale) return Promise.reject(new TypeError('boom'));
    return Promise.resolve({ alreadyApplied: false });
  }

  revokeFleetInvokers(_service: string): Promise<ActionOutcome> {
    return Promise.resolve({ alreadyApplied: false });
  }

  isTripped(_service: string): Promise<boolean> {
    return Promise.resolve(this.tripped);
  }

  markTripped(_service: string): Promise<void> {
    this.tripped = true;
    return Promise.resolve();
  }
}

/** Wrap a budget notification in the Pub/Sub push envelope Google sends. */
function push(notification: Record<string, unknown>): unknown {
  return {
    message: { data: Buffer.from(JSON.stringify(notification)).toString('base64') },
    subscription: 'projects/all-thinkgs/subscriptions/billing-kill-switch-push',
  };
}

const OVER_BUDGET = {
  budgetDisplayName: 'agentic-fleet-kill-switch',
  costAmount: 60,
  budgetAmount: 50,
  currencyCode: 'USD',
};

let server: ReturnType<express.Application['listen']>;
let base: string;
let actions: StubActions;

beforeEach(async () => {
  actions = new StubActions();
  const logger: Logger = createLogger({ agent: 'kill-switch', write: () => {} });
  const app = createApp({
    config: loadConfig({ agent: 'kill-switch', env: { GOOGLE_CLOUD_PROJECT: 'all-thinkgs' } }),
    logger,
    actions,
    targets: { gatewayService: 'gateway-agent', gemmaService: 'gemma-serving' },
  });

  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
});

/** POST one push body and report the status code Pub/Sub would see. */
async function deliver(body: unknown): Promise<number> {
  const response = await fetch(`${base}/pubsub/push`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return response.status;
}

describe('the push endpoint makes delivery terminal', () => {
  it('acknowledges a successful trip', async () => {
    expect(await deliver(push(OVER_BUDGET))).toBe(204);
  });

  it('acknowledges a FAILED trip rather than asking for redelivery', async () => {
    // The reversal that ends the loop. This answered 500 during the live fire.
    actions.failScale = true;

    expect(await deliver(push(OVER_BUDGET))).toBe(200);
  });

  it('acknowledges a redelivery of an already-tripped notification', async () => {
    await deliver(push(OVER_BUDGET));

    expect(await deliver(push(OVER_BUDGET))).toBe(204);
  });

  it('answers 4xx for a malformed message, so it is dropped rather than retried', async () => {
    // A message that will never become valid must not occupy the retry window.
    expect(await deliver({ not: 'an envelope' })).toBe(400);
  });

  it('never answers 5xx, which is what would re-arm redelivery', async () => {
    actions.failScale = true;
    const statuses = [
      await deliver(push(OVER_BUDGET)),
      await deliver(push(OVER_BUDGET)),
      await deliver({ not: 'an envelope' }),
    ];

    expect(statuses.every((status) => status < 500)).toBe(true);
  });
});
