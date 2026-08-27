/**
 * Parse the Cloud Billing budget notification that arrives over Pub/Sub push.
 *
 * Two nested envelopes have to be peeled before a decision can be made: the
 * Pub/Sub push wrapper (`{ message: { data: <base64>, attributes: {...} } }`)
 * and, inside it, the budget notification JSON documented at
 * cloud.google.com/billing/docs/how-to/budgets-programmatic-notifications.
 *
 * zod at the boundary, like every other external input in this repo: a
 * malformed body must be rejected by shape, not discovered by a `TypeError`
 * halfway through the decision. The distinction that matters here is between
 * *unparseable* (something is wrong; refuse and let the operator look) and
 * *parsed but under budget* (the overwhelmingly common case; do nothing).
 */

import { z } from 'zod';

/**
 * The budget notification payload.
 *
 * Only the four fields the decision rests on are required. Google adds fields
 * to this message over time (`alertThresholdExceeded`, `forecastThresholdExceeded`,
 * `currencyCode`, `schemaVersion`), and rejecting an unknown one would turn a
 * harmless upstream addition into a kill switch that never fires. zod strips
 * unknown keys by default, which is the behaviour wanted here.
 *
 * Why not trust `alertThresholdExceeded`: it is present only on the message
 * that crosses a threshold, and it reports the *rule* that fired rather than
 * the ratio actually reached. Comparing `costAmount` against `budgetAmount`
 * directly is one number against one number, and it holds no matter which
 * threshold rules the budget happens to carry.
 */
export const BudgetNotificationSchema = z.object({
  budgetDisplayName: z.string(),
  costAmount: z.number().finite(),
  budgetAmount: z.number().finite(),
  costIntervalStart: z.string().optional(),
  currencyCode: z.string().optional(),
  alertThresholdExceeded: z.number().finite().optional(),
  forecastThresholdExceeded: z.number().finite().optional(),
});

export type BudgetNotification = z.infer<typeof BudgetNotificationSchema>;

/**
 * The Pub/Sub push envelope.
 *
 * `data` is base64 and may legitimately be absent: Pub/Sub allows an
 * attribute-only message, and the budget publisher emits one when the message
 * carries no cost data yet. Such a message is parsed successfully and decides
 * "no action", rather than being treated as an error.
 */
export const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().optional(),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string().optional(),
});

export type PushEnvelope = z.infer<typeof PushEnvelopeSchema>;

/** Why a notification could not be turned into a decision. */
export type ParseFailure =
  | 'envelope_invalid'
  | 'data_not_base64'
  | 'data_not_json'
  | 'notification_invalid';

export type ParseResult =
  | { readonly ok: true; readonly notification: BudgetNotification | undefined }
  | { readonly ok: false; readonly error: ParseFailure };

/**
 * Decode a push request body into a budget notification.
 *
 * Returns `notification: undefined` for a well-formed envelope that carries no
 * data — a valid message that simply says nothing about cost.
 */
export function parsePushBody(body: unknown): ParseResult {
  const envelope = PushEnvelopeSchema.safeParse(body);
  if (!envelope.success) return { ok: false, error: 'envelope_invalid' };

  const encoded = envelope.data.message.data;
  if (encoded === undefined || encoded === '') return { ok: true, notification: undefined };

  let decoded: string;
  try {
    decoded = Buffer.from(encoded, 'base64').toString('utf8');
  } catch {
    return { ok: false, error: 'data_not_base64' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return { ok: false, error: 'data_not_json' };
  }

  const notification = BudgetNotificationSchema.safeParse(parsed);
  if (!notification.success) return { ok: false, error: 'notification_invalid' };

  return { ok: true, notification: notification.data };
}

/**
 * Whether this notification means "stop spending".
 *
 * `>=`, not `>`: a budget reached exactly is a budget exhausted. The 0.5 and
 * 0.8 threshold rules exist so the notification arrives early enough to be seen
 * in the logs; only the 1.0 crossing is allowed to take the fleet down.
 */
export function isOverBudget(notification: BudgetNotification): boolean {
  return notification.costAmount >= notification.budgetAmount;
}

/**
 * The fraction of the budget consumed, for logging.
 *
 * A zero budget would divide by zero. It cannot be configured through
 * `var.budget_usd` (Terraform validates it as positive), but the number arrives
 * from outside this process, so the guard stays.
 */
export function budgetRatio(notification: BudgetNotification): number {
  if (notification.budgetAmount <= 0) return notification.costAmount > 0 ? 1 : 0;
  return notification.costAmount / notification.budgetAmount;
}
