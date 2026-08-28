/**
 * The two mutations that stop the fleet from spending money.
 *
 * Both are expressed against a narrow `KillActions` interface rather than
 * against `ServicesClient` directly. Why: Pub/Sub redelivers, the handler must
 * be provable idempotent, and a test that has to stand up a Cloud Run Admin API
 * double proves nothing about idempotency — it proves something about the
 * double. The interface is the seam; `cloudRunActions()` is the one
 * implementation that touches Google Cloud.
 *
 * Both operations are *idempotent by construction*, not by remembering that
 * they ran. Removing a member that is already absent and setting a maximum that
 * is already 0 are both no-ops, so a redelivered message costs one API read and
 * changes nothing. There is deliberately no dedupe store: a cache that says
 * "already handled" is one more thing that can be wrong at the moment the fleet
 * is burning money.
 */

import { ServicesClient } from '@google-cloud/run';

/** What one mutation did, for the structured log and the HTTP response. */
export interface ActionOutcome {
  /** True when the resource was already in the desired state. */
  readonly alreadyApplied: boolean;
}

/**
 * The mutations the kill switch performs.
 *
 * Named for the effect, not the API call, so a future implementation (an
 * internal load balancer rule, a different scale-to-zero mechanism) can be
 * swapped in without renaming the handler's vocabulary.
 */
export interface KillActions {
  /** Remove the `allUsers` run.invoker binding, closing the public door. */
  revokePublicInvoker(service: string): Promise<ActionOutcome>;
  /** Force the service's maximum instance count to zero. */
  scaleToZero(service: string): Promise<ActionOutcome>;
  /** True when this service already carries the tripped marker. */
  isTripped(service: string): Promise<boolean>;
  /** Record that the switch has fired, so a redelivery becomes a no-op. */
  markTripped(service: string): Promise<void>;
}

/**
 * Annotation recording that the switch has fired.
 *
 * Why an annotation on the gateway service rather than a Firestore document or
 * a cache: the kill switch must keep working when everything else is broken,
 * and this adds no dependency it did not already have — it already holds
 * run.admin on this exact service. The marker also lives where an operator
 * looks anyway, and `just restore-after-kill` clears it through Terraform.
 */
export const TRIPPED_ANNOTATION = 'kill-switch/tripped';

export interface CloudRunActionsOptions {
  readonly project: string;
  readonly region: string;
  /** Injected by tests. Real callers let the client build itself from ADC. */
  readonly client?: ServicesClient | undefined;
}

/** The `roles/run.invoker` binding is the one the public reaches the gateway through. */
const INVOKER_ROLE = 'roles/run.invoker';
/** The member that makes a Cloud Run service unauthenticated. */
const PUBLIC_MEMBER = 'allUsers';

/** Fully-qualified Cloud Run service resource name. */
function serviceName(project: string, region: string, service: string): string {
  return `projects/${project}/locations/${region}/services/${service}`;
}

/**
 * The Cloud Run Admin API implementation.
 *
 * Authentication is Application Default Credentials — on Cloud Run that is the
 * service's own service account, which Terraform grants `roles/run.admin` on
 * exactly the two target services. Why not a project-wide grant: an identity
 * reachable from a public push endpoint should be able to damage only the two
 * services it exists to stop.
 */
export function cloudRunActions(options: CloudRunActionsOptions): KillActions {
  const { project, region } = options;
  const client = options.client ?? new ServicesClient();

  return {
    async revokePublicInvoker(service: string): Promise<ActionOutcome> {
      const resource = serviceName(project, region, service);
      const [policy] = await client.getIamPolicy({ resource });
      const bindings = policy.bindings ?? [];

      // Read-modify-write on the whole policy, keeping `etag`: setIamPolicy is
      // authoritative, so dropping the etag would let a concurrent writer's
      // change be silently overwritten instead of failing the call.
      const invoker = bindings.find((binding) => binding.role === INVOKER_ROLE);
      const hasPublic = invoker?.members?.includes(PUBLIC_MEMBER) ?? false;
      if (!hasPublic) return { alreadyApplied: true };

      const next = bindings
        .map((binding) => {
          if (binding.role !== INVOKER_ROLE) return binding;
          return {
            ...binding,
            members: (binding.members ?? []).filter((member) => member !== PUBLIC_MEMBER),
          };
        })
        // A role binding with no members is invalid input to setIamPolicy, so
        // an emptied binding is removed rather than sent as an empty list.
        .filter((binding) => (binding.members ?? []).length > 0);

      await client.setIamPolicy({
        resource,
        policy: { ...policy, bindings: next },
      });

      return { alreadyApplied: false };
    },

    async scaleToZero(service: string): Promise<ActionOutcome> {
      const name = serviceName(project, region, service);
      const [current] = await client.getService({ name });

      // `template.scaling` is the cap that governs autoscaling, and the one
      // this switch exists to force to zero: it is what Cloud Run surfaces as
      // the `autoscaling.knative.dev/maxScale` annotation, and what the live
      // fire measured as "still 1" when the switch failed.
      //
      // The top-level `scaling` is a *different*, newer field — the service's
      // manual instance count, inert unless `scalingMode` selects manual
      // scaling. It is set alongside for completeness, but it is deliberately
      // NOT part of the success condition: proto3 cannot distinguish an
      // explicit 0 from an unset field, so the server drops that write and the
      // value read back stays 1 forever. Requiring it to be 0 would make the
      // action throw on every trip even though the GPU is genuinely capped.
      const revisionScaling = current.template?.scaling;
      const serviceScaling = current.scaling;
      if (revisionScaling?.maxInstanceCount === 0) return { alreadyApplied: true };

      // The whole Service message is sent back with only the two scaling fields
      // changed. Why not an update mask limited to them: Cloud Run v2's
      // updateService treats an absent field under a mask as "clear it", and a
      // partial mask on a nested message has repeatedly proved easier to get
      // wrong than a full-object write of a freshly-read object. A full write
      // was verified against the real service (validateOnly) and is accepted.
      const [operation] = await client.updateService({
        service: {
          ...current,
          scaling: { ...serviceScaling, maxInstanceCount: 0 },
          template: {
            ...current.template,
            scaling: { ...revisionScaling, maxInstanceCount: 0 },
          },
        },
      });

      // The operation is awaited, but its rejection is NOT the verdict.
      //
      // Awaiting at all is the fix for the original bug: updateService returns a
      // long-running operation, and the old code awaited only the call that
      // *starts* it, so the handler reported success while gemma-serving kept
      // maxInstanceCount = 1. setIamPolicy returns the policy directly, with no
      // operation to await — which is exactly why revokePublicInvoker worked and
      // this did not.
      //
      // Why the rejection is swallowed: on this GPU service the operation
      // reports a failure while the scaling change still lands. Observed live on
      // 2026-08-28 — the LRO rejected at 01:38:49.535, and Cloud Run logged
      // "Ready condition status changed to True" for the new revision one second
      // later, with the cap correctly at zero. The operation is really reporting
      // on the revision coming up (a GPU service that cannot start an instance
      // when its own maximum is zero), not on whether the cap was written.
      let operationError: unknown;
      try {
        await operation.promise();
      } catch (error) {
        operationError = error;
      }

      // The service's own state is the verdict, because it is the thing that
      // costs money. A cost gate that cries failure on a successful trip is as
      // harmful as one that stays silent on a failed one: it re-arms the
      // operator's alarm for a fleet that is already stopped.
      //
      // A zero comes back as an absent field, because proto3 omits zero values,
      // so "0 or unset" is success and a surviving non-zero number is failure.
      const [confirmed] = await client.getService({ name });
      const cap = confirmed.template?.scaling?.maxInstanceCount;
      const applied = cap === 0 || cap === null || cap === undefined;
      if (!applied) {
        // Prefer the operation's error when there is one: it explains *why* the
        // write did not take, which a bare assertion cannot.
        throw operationError instanceof Error
          ? operationError
          : new Error('scale_to_zero_not_applied');
      }

      return { alreadyApplied: false };
    },

    async isTripped(service: string): Promise<boolean> {
      const name = serviceName(project, region, service);
      const [current] = await client.getService({ name });
      return (current.annotations ?? {})[TRIPPED_ANNOTATION] !== undefined;
    },

    async markTripped(service: string): Promise<void> {
      const name = serviceName(project, region, service);
      const [current] = await client.getService({ name });

      // The timestamp is the value so an operator can see *when* without
      // consulting the logs. Written last, after both mutations have been
      // confirmed, so the marker can never claim a trip that did not happen.
      const [operation] = await client.updateService({
        service: {
          ...current,
          annotations: {
            ...current.annotations,
            [TRIPPED_ANNOTATION]: new Date().toISOString(),
          },
        },
      });
      await operation.promise();
    },
  };
}
