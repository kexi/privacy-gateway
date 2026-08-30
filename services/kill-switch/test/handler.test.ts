/**
 * What the cost kill switch guarantees.
 *
 * The three properties that matter: it fires when spend reaches the budget, it
 * does nothing when spend is below it, and a redelivered message changes
 * nothing that the first delivery already changed.
 */

import { createLogger, type Logger } from '@privacy-gateway/common/logging';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActionOutcome, KillActions } from '../src/actions.ts';
import { handleNotification, type KillTargets } from '../src/handler.ts';

const TARGETS: KillTargets = {
  gatewayService: 'gateway-agent',
  gemmaService: 'gemma-serving',
};

/** Captured log lines, so a test can assert on what was reported. */
function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    agent: 'kill-switch',
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

/**
 * A stand-in for the Cloud Run Admin API that models the one property under
 * test: the real operations are no-ops once the desired state is reached, so
 * this one reports `alreadyApplied` on every call after the first.
 */
class FakeActions implements KillActions {
  public readonly invokerCalls: string[] = [];
  public readonly scaleCalls: string[] = [];
  public readonly fleetInvokerCalls: string[] = [];
  public readonly markCalls: string[] = [];
  public failOn: 'none' | 'invoker' | 'scale' | 'fleet' | 'mark' | 'isTripped' = 'none';
  /** The `kill-switch/tripped` annotation, as the real service would hold it. */
  public tripped = false;

  private invokerRevoked = false;
  private scaledToZero = false;
  private fleetInvokersRevoked = false;

  isTripped(_service: string): Promise<boolean> {
    if (this.failOn === 'isTripped') return Promise.reject(new TypeError('boom'));
    return Promise.resolve(this.tripped);
  }

  markTripped(service: string): Promise<void> {
    this.markCalls.push(service);
    if (this.failOn === 'mark') return Promise.reject(new TypeError('boom'));
    this.tripped = true;
    return Promise.resolve();
  }

  revokePublicInvoker(service: string): Promise<ActionOutcome> {
    this.invokerCalls.push(service);
    if (this.failOn === 'invoker') return Promise.reject(new TypeError('boom'));
    const alreadyApplied = this.invokerRevoked;
    this.invokerRevoked = true;
    return Promise.resolve({ alreadyApplied });
  }

  scaleToZero(service: string): Promise<ActionOutcome> {
    this.scaleCalls.push(service);
    if (this.failOn === 'scale') return Promise.reject(new TypeError('boom'));
    const alreadyApplied = this.scaledToZero;
    this.scaledToZero = true;
    return Promise.resolve({ alreadyApplied });
  }

  revokeFleetInvokers(service: string): Promise<ActionOutcome> {
    this.fleetInvokerCalls.push(service);
    if (this.failOn === 'fleet') return Promise.reject(new TypeError('boom'));
    const alreadyApplied = this.fleetInvokersRevoked;
    this.fleetInvokersRevoked = true;
    return Promise.resolve({ alreadyApplied });
  }
}

/** Wrap a budget notification in the Pub/Sub push envelope Google sends. */
function push(notification: Record<string, unknown>): unknown {
  return {
    subscription: 'projects/all-thinkgs/subscriptions/billing-kill-switch-push',
    message: {
      messageId: '1',
      data: Buffer.from(JSON.stringify(notification), 'utf8').toString('base64'),
    },
  };
}

/** A notification at a given fraction of a $50 budget. */
function atRatio(ratio: number): Record<string, unknown> {
  return {
    budgetDisplayName: 'agentic-fleet-budget',
    costAmount: 50 * ratio,
    budgetAmount: 50,
    currencyCode: 'USD',
  };
}

describe('handleNotification', () => {
  let actions: FakeActions;
  let logger: Logger;
  let lines: Record<string, unknown>[];

  beforeEach(() => {
    actions = new FakeActions();
    ({ logger, lines } = captureLogger());
  });

  const handle = (body: unknown) => handleNotification(body, { actions, logger, targets: TARGETS });

  describe('threshold parsing', () => {
    it('does nothing when spend is below the budget', async () => {
      const outcome = await handle(push(atRatio(0.8)));

      expect(outcome).toEqual({ kind: 'under_budget', ratio: 0.8 });
      expect(actions.invokerCalls).toEqual([]);
      expect(actions.scaleCalls).toEqual([]);
    });

    it('fires when spend exactly reaches the budget', async () => {
      // A budget reached exactly is a budget exhausted, so the comparison is
      // `>=`. This is the boundary that decides it.
      const outcome = await handle(push(atRatio(1)));

      expect(outcome.kind).toBe('triggered');
      expect(actions.invokerCalls).toEqual(['gateway-agent']);
      expect(actions.scaleCalls).toEqual(['gemma-serving']);
      expect(actions.fleetInvokerCalls).toEqual(['gemma-serving']);
    });

    it('fires when spend overshoots the budget', async () => {
      const outcome = await handle(push(atRatio(1.4)));

      expect(outcome).toMatchObject({ kind: 'triggered', ratio: 1.4 });
    });

    it('reports the cost figures in the triggered event', async () => {
      await handle(push(atRatio(1.2)));

      const triggered = lines.find((line) => line['event'] === 'killswitch.triggered');
      expect(triggered).toMatchObject({
        severity: 'WARNING',
        agent: 'kill-switch',
        cost_amount: 60,
        budget_amount: 50,
        budget_ratio: 1.2,
      });
      // The allowlist must carry every field this event emits, or the figures
      // are silently dropped from the only record that the switch fired.
      expect(triggered?.['dropped_fields']).toBeUndefined();
    });

    it('ignores a threshold notification that carries no cost data', async () => {
      const outcome = await handle({ message: { messageId: '1' } });

      expect(outcome).toEqual({ kind: 'no_data' });
      expect(actions.invokerCalls).toEqual([]);
    });
  });

  describe('malformed input', () => {
    it.each([
      ['a non-envelope body', { nope: true }, 'envelope_invalid'],
      ['data that is not JSON', { message: { data: 'bm90IGpzb24=' } }, 'data_not_json'],
      [
        'JSON missing the cost fields',
        { message: { data: Buffer.from('{"budgetDisplayName":"x"}').toString('base64') } },
        'notification_invalid',
      ],
    ])('rejects %s without touching anything', async (_label, body, error) => {
      const outcome = await handle(body);

      // A cost gate that cannot parse its input must not shut the fleet down on
      // a guess: taking the demo offline because a malformed message arrived is
      // itself the failure this switch exists to avoid.
      expect(outcome).toEqual({ kind: 'rejected', error });
      expect(actions.invokerCalls).toEqual([]);
      expect(actions.scaleCalls).toEqual([]);
    });
  });

  describe('one trip per notification, under Pub/Sub redelivery', () => {
    it('acts on the first delivery and does nothing at all on the second', async () => {
      const first = await handle(push(atRatio(1.1)));
      const second = await handle(push(atRatio(1.1)));

      expect(first).toMatchObject({
        kind: 'triggered',
        invokerAlreadyRevoked: false,
        gemmaAlreadyScaledToZero: false,
        fleetInvokersAlreadyRevoked: false,
      });
      // Not "triggered, already applied": the redelivery must not re-run the
      // mutations at all. Re-revoking is what fought the operator's restore
      // during the live fire, seconds after each `tf-apply` put the binding back.
      expect(second).toEqual({ kind: 'already_tripped' });
      expect(actions.invokerCalls).toEqual(['gateway-agent']);
      expect(actions.scaleCalls).toEqual(['gemma-serving']);
      expect(actions.fleetInvokerCalls).toEqual(['gemma-serving']);
    });

    it('never re-revokes across many redeliveries', async () => {
      for (let i = 0; i < 5; i += 1) await handle(push(atRatio(2)));

      // The property that ends the loop: five deliveries, one trip.
      expect(actions.invokerCalls).toHaveLength(1);
      expect(actions.scaleCalls).toHaveLength(1);
      expect(lines.filter((line) => line['event'] === 'killswitch.completed')).toHaveLength(1);
      expect(lines.filter((line) => line['event'] === 'killswitch.already_tripped')).toHaveLength(
        4,
      );
    });

    it('marks the trip only after both mutations have succeeded', async () => {
      await handle(push(atRatio(1.1)));

      expect(actions.markCalls).toEqual(['gateway-agent']);
    });

    it('does not mark a trip that failed, so a later delivery can still act', async () => {
      actions.failOn = 'scale';
      await handle(push(atRatio(1.1)));

      expect(actions.markCalls).toEqual([]);
      expect(actions.tripped).toBe(false);
    });

    it('trips anyway when the marker cannot be read', async () => {
      // Failing to stop a real overspend is worse than acting twice, so an
      // unreadable marker must not become a reason to do nothing.
      actions.failOn = 'isTripped';

      expect(await handle(push(atRatio(1.1)))).toMatchObject({ kind: 'triggered' });
    });

    it('still reports success when the marker cannot be written', async () => {
      // The fleet is already stopped at this point; refusing here would turn a
      // successful trip back into a redelivery loop.
      actions.failOn = 'mark';

      expect(await handle(push(atRatio(1.1)))).toMatchObject({ kind: 'triggered' });
      expect(lines.some((line) => line['event'] === 'killswitch.mark_failed')).toBe(true);
    });
  });

  describe('partial failure', () => {
    it('reports a failure and stops when the IAM change fails', async () => {
      actions.failOn = 'invoker';

      const outcome = await handle(push(atRatio(1.1)));

      // Reported as failed, but the push endpoint answers 2xx (see server.ts):
      // one notification causes at most one trip attempt.
      expect(outcome).toEqual({ kind: 'failed', error: 'TypeError' });
      expect(actions.scaleCalls).toEqual([]);
    });

    it('reports a failure when scaling fails, having already closed the door', async () => {
      actions.failOn = 'scale';

      const outcome = await handle(push(atRatio(1.1)));

      // Gateway first is deliberate: if the second call fails, the fleet is at
      // least no longer publicly reachable.
      expect(outcome).toEqual({ kind: 'failed', error: 'TypeError' });
      expect(actions.invokerCalls).toEqual(['gateway-agent']);
    });

    it('never logs an exception message', async () => {
      actions.failOn = 'scale';

      await handle(push(atRatio(1.1)));

      const failed = lines.find((line) => line['event'] === 'killswitch.failed');
      expect(failed).toMatchObject({ error_class: 'TypeError' });
      expect(JSON.stringify(failed)).not.toContain('boom');
    });
  });
});
