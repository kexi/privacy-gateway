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
  | { readonly kind: 'failed'; readonly error: string };

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
    // A 500 makes Pub/Sub redeliver, which is exactly what is wanted: the
    // operations are idempotent, so a retry re-attempts the half that failed
    // and no-ops the half that succeeded.
    const errorClass = error instanceof Error ? error.name : 'unknown_error';
    logger.event('killswitch.failed', { ...fields, error_class: errorClass }, 'ERROR');
    return { kind: 'failed', error: errorClass };
  }
}
