/**
 * Decide what a budget notification means, and act on it.
 *
 * This module holds the whole decision. `server.ts` is transport, `actions.ts`
 * is the Cloud Run API; everything that determines *whether the fleet gets shut
 * down* lives here so one vitest suite covers it end to end.
 *
 * The fail-closed rule this repo applies to disclosure gates does not transfer
 * unchanged to a cost gate. A disclosure gate that cannot decide must refuse,
 * because releasing data on a guess is unrecoverable. A cost gate that cannot
 * parse its input must *not* shut the fleet down on a guess: taking the demo
 * offline because a malformed message arrived is itself the failure. So an
 * unparseable notification is reported (HTTP 400, logged at ERROR) and nothing
 * is touched, and only an arithmetic comparison of two numbers fires the
 * switch.
 *
 * The same reasoning makes delivery *terminal*. A disclosure gate retries
 * because a missed refusal leaks data; a cost gate that retries forever becomes
 * the outage. The live fire proved it: `scaleToZero` failed, the endpoint
 * answered 500, and Pub/Sub redelivered every ~30 s for 11 minutes, re-revoking
 * the gateway's public binding seconds after each operator restore until the
 * retention window drained. So a trip is attempted at most once — recorded by a
 * `kill-switch/tripped` annotation, cleared by `just restore-after-kill` — and
 * the push endpoint acknowledges even a partial failure, leaving the ERROR log
 * and the dead-letter topic as the operator's signal rather than a retry storm.
 */

import type { Logger } from '@privacy-gateway/common';
import type { KillActions } from './actions.ts';
import {
  budgetRatio,
  isOverBudget,
  parsePushBody,
  type BudgetNotification,
} from './notification.ts';

/** Services the switch acts on, in the order it acts on them. */
export interface KillTargets {
  /** The public entry point; its `allUsers` invoker binding is removed. */
  readonly gatewayService: string;
  /** The GPU service; its max instance count is forced to zero. */
  readonly gemmaService: string;
}

export type HandlerOutcome =
  /** Malformed input. Nothing was touched; the operator should look. */
  | { readonly kind: 'rejected'; readonly error: string }
  /** Well-formed and under budget. Logged, nothing touched. */
  | { readonly kind: 'under_budget'; readonly ratio: number }
  /** Well-formed, no cost data. Nothing to decide. */
  | { readonly kind: 'no_data' }
  /** Over budget. Both mutations attempted. */
  | {
      readonly kind: 'triggered';
      readonly ratio: number;
      readonly invokerAlreadyRevoked: boolean;
      readonly gemmaAlreadyScaledToZero: boolean;
    }
  /** Over budget, but a mutation failed. The switch did not fully engage. */
  | { readonly kind: 'failed'; readonly error: string }
  /** Over budget, but this trip was already attempted. Nothing was touched. */
  | { readonly kind: 'already_tripped' };

export interface HandleOptions {
  readonly actions: KillActions;
  readonly logger: Logger;
  readonly targets: KillTargets;
}

/**
 * Round a ratio to two decimals so it stays a stable log value.
 *
 * `budget_ratio` is a `number` field on the log allowlist, and an unrounded
 * float would make otherwise identical lines differ in their last digits.
 */
function roundRatio(ratio: number): number {
  return Math.round(ratio * 100) / 100;
}

/** Log the cost figures. No PII exists in a billing notification. */
function costFields(notification: BudgetNotification): Record<string, number> {
  return {
    cost_amount: notification.costAmount,
    budget_amount: notification.budgetAmount,
    budget_ratio: roundRatio(budgetRatio(notification)),
  };
}

/**
 * Handle one Pub/Sub push body.
 *
 * Never throws: the caller maps the outcome to a status code, and a thrown
 * error there would become a 500, which Pub/Sub retries — turning a bug in this
 * function into an unbounded redelivery loop.
 */
export async function handleNotification(
  body: unknown,
  options: HandleOptions,
): Promise<HandlerOutcome> {
  const { actions, logger, targets } = options;

  const parsed = parsePushBody(body);
  if (!parsed.ok) {
    logger.event('killswitch.notification_invalid', { error_code: parsed.error }, 'ERROR');
    return { kind: 'rejected', error: parsed.error };
  }

  const notification = parsed.notification;
  if (notification === undefined) {
    logger.event('killswitch.notification_empty');
    return { kind: 'no_data' };
  }

  const fields = costFields(notification);

  if (!isOverBudget(notification)) {
    // The 0.5 and 0.8 threshold rules land here. They exist to put the spend
    // trajectory in Cloud Logging early, not to change anything.
    logger.event('killswitch.under_budget', fields);
    return { kind: 'under_budget', ratio: fields['budget_ratio'] ?? 0 };
  }

  // A trip that has already been attempted must not be attempted again.
  //
  // Why this check exists at all: the mutations are individually idempotent,
  // but revoke-then-restore is not idempotent *against an operator restoring in
  // parallel*. During the live fire the handler re-revoked every ~30 s for 11
  // minutes and took the binding away again seconds after a `tf-apply` had put
  // it back, so recovery was impossible until the retention window drained. The
  // marker makes the trip a one-shot: the operator's restore is what clears it.
  const alreadyTripped = await actions
    .isTripped(targets.gatewayService)
    // A marker that cannot be read must not block the switch: failing to stop a
    // real overspend is worse than acting twice. Falls through to the trip.
    .catch(() => false);

  if (alreadyTripped) {
    logger.event('killswitch.already_tripped', fields, 'WARNING');
    return { kind: 'already_tripped' };
  }

  logger.event('killswitch.triggered', fields, 'WARNING');

  try {
    // Sequential, gateway first, deliberately. Closing the public door stops
    // new requests from arriving; scaling Gemma to zero stops the expensive
    // half. Doing the cheap, instantaneous IAM change first means that if the
    // second call fails, the fleet is at least no longer reachable.
    const invoker = await actions.revokePublicInvoker(targets.gatewayService);
    logger.event('killswitch.invoker_revoked', {
      ...fields,
      already_applied: invoker.alreadyApplied,
    });

    const scaled = await actions.scaleToZero(targets.gemmaService);
    logger.event('killswitch.scaled_to_zero', {
      ...fields,
      already_applied: scaled.alreadyApplied,
    });

    // Written only once both mutations have been confirmed, so the marker never
    // claims a trip that did not fully engage. A marker that cannot be written
    // is logged and tolerated: the fleet is already stopped, and refusing here
    // would turn a successful trip back into a redelivery loop.
    try {
      await actions.markTripped(targets.gatewayService);
    } catch (error) {
      logger.event(
        'killswitch.mark_failed',
        { ...fields, error_class: error instanceof Error ? error.name : 'unknown_error' },
        'WARNING',
      );
    }

    logger.event('killswitch.completed', {
      ...fields,
      already_applied: invoker.alreadyApplied && scaled.alreadyApplied,
    });

    return {
      kind: 'triggered',
      ratio: fields['budget_ratio'] ?? 0,
      invokerAlreadyRevoked: invoker.alreadyApplied,
      gemmaAlreadyScaledToZero: scaled.alreadyApplied,
    };
  } catch (error) {
    // Reported as a failure, but the transport answers 2xx anyway — see the
    // status mapping in `server.ts`. A 500 here is what produced the revoke
    // loop: the failing half never started succeeding, so Pub/Sub redelivered
    // for the whole retention window and re-ran the half that *had* worked.
    const errorClass = error instanceof Error ? error.name : 'unknown_error';
    logger.event('killswitch.failed', { ...fields, error_class: errorClass }, 'ERROR');
    return { kind: 'failed', error: errorClass };
  }
}
