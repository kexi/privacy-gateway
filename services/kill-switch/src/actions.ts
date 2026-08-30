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
 * Every operation is *idempotent by construction*, not by remembering that it
 * ran. Removing a member that is already absent, and setting a scaling mode and
 * count that already hold, are both no-ops, so a redelivered message costs one
 * API read and changes nothing. There is deliberately no dedupe store: a cache
 * that says "already handled" is one more thing that can be wrong at the moment
 * the fleet is burning money.
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
  /** Hold the service at zero instances via Cloud Run manual scaling. */
  scaleToZero(service: string): Promise<ActionOutcome>;
  /**
   * Remove the fleet's own run.invoker bindings on a service.
   *
   * Belt and braces beside `scaleToZero`: manual scaling is what actually stops
   * the GPU, and this makes sure that even if a request somehow reaches Cloud
   * Run, no member of the fleet is allowed to be the one making it.
   */
  revokeFleetInvokers(service: string): Promise<ActionOutcome>;
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
  /**
   * The fleet identities `revokeFleetInvokers` strips, as IAM member strings
   * (`serviceAccount:...`). Configured rather than derived so the switch never
   * has to guess which principals belong to the fleet.
   */
  readonly fleetMembers?: readonly string[] | undefined;
  /** Injected by tests. Real callers let the client build itself from ADC. */
  readonly client?: ServicesClient | undefined;
}

/** The `roles/run.invoker` binding is the one the public reaches the gateway through. */
const INVOKER_ROLE = 'roles/run.invoker';
/** The member that makes a Cloud Run service unauthenticated. */
const PUBLIC_MEMBER = 'allUsers';

/**
 * `ServiceScaling.ScalingMode.MANUAL`, written as the string form.
 *
 * Why the string and not the numeric enum member: the client accepts either,
 * and the string is what `getService` returns, so writing and reading the same
 * representation keeps the success check from comparing 2 against 'MANUAL'.
 */
const MANUAL_SCALING_MODE = 'MANUAL' as const;

/** True for either representation the client may hand back for MANUAL. */
function isManualMode(mode: unknown): boolean {
  return mode === MANUAL_SCALING_MODE || mode === 2;
}

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
  const fleetMembers = options.fleetMembers ?? [];
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

      // Manual scaling is the documented way to hold a Cloud Run service at
      // zero instances: `scaling.scalingMode = MANUAL` with
      // `scaling.manualInstanceCount = 0`.
      //
      // Why not `template.scaling.maxInstanceCount = 0`, which the previous
      // implementation wrote: Cloud Run's maximum is an integer from 1 upward,
      // and `RevisionScaling.maxInstanceCount` is a plain proto3 int32 with no
      // presence tracking, so a 0 is not serialised at all. The server sees an
      // absent field, which means "no maximum" — the limit is *removed*, not set
      // to zero — and the old success check then read that same absent field
      // back and called it proof of a zero cap. The switch reported a capped GPU
      // while nothing capped it.
      //
      // `ServiceScaling.manualInstanceCount` is the one field here declared
      // `proto3_optional` (synthetic oneof `_manualInstanceCount`), so an
      // explicit 0 is presence-tracked and survives the round trip. That is what
      // makes zero expressible at all.
      const serviceScaling = current.scaling;
      const alreadyManualZero =
        isManualMode(serviceScaling?.scalingMode) && serviceScaling?.manualInstanceCount === 0;
      if (alreadyManualZero) return { alreadyApplied: true };

      // The whole Service message is sent back with only the scaling block
      // changed. Why not an update mask limited to it: Cloud Run v2's
      // updateService treats an absent field under a mask as "clear it", and a
      // partial mask on a nested message has repeatedly proved easier to get
      // wrong than a full-object write of a freshly-read object.
      const [operation] = await client.updateService({
        service: {
          ...current,
          scaling: {
            ...serviceScaling,
            scalingMode: MANUAL_SCALING_MODE,
            manualInstanceCount: 0,
          },
        },
      });

      // The operation is awaited, but its rejection is NOT the verdict.
      //
      // Awaiting at all is the fix for the original bug: updateService returns a
      // long-running operation, and the old code awaited only the call that
      // *starts* it, so the handler reported success while gemma-serving kept
      // serving. setIamPolicy returns the policy directly, with no operation to
      // await — which is exactly why revokePublicInvoker worked and this did not.
      //
      // Why the rejection is swallowed: on this GPU service the operation
      // reports a failure while the scaling change still lands, because it is
      // really reporting on a revision that is being told to run zero instances.
      // The read-back below is what decides, so a misleading LRO error cannot
      // make a stopped fleet look running.
      let operationError: unknown;
      try {
        await operation.promise();
      } catch (error) {
        operationError = error;
      }

      // The service's own state is the verdict, because it is the thing that
      // costs money — and it is read *explicitly*, as a mode plus a count.
      // Nothing is inferred from an absent field: the previous implementation's
      // whole failure was treating "the server did not send this" as "the server
      // agreed with me".
      const [confirmed] = await client.getService({ name });
      const mode = confirmed.scaling?.scalingMode;
      const count = confirmed.scaling?.manualInstanceCount;
      const applied = isManualMode(mode) && count === 0;
      if (!applied) {
        // Prefer the operation's error when there is one: it explains *why* the
        // write did not take, which a bare assertion cannot.
        throw operationError instanceof Error
          ? operationError
          : new Error('scale_to_zero_not_applied');
      }

      return { alreadyApplied: false };
    },

    async revokeFleetInvokers(service: string): Promise<ActionOutcome> {
      const resource = serviceName(project, region, service);
      const [policy] = await client.getIamPolicy({ resource });
      const bindings = policy.bindings ?? [];

      const invoker = bindings.find((binding) => binding.role === INVOKER_ROLE);
      const present = (invoker?.members ?? []).filter((member) => fleetMembers.includes(member));
      if (present.length === 0) return { alreadyApplied: true };

      const next = bindings
        .map((binding) => {
          if (binding.role !== INVOKER_ROLE) return binding;
          return {
            ...binding,
            members: (binding.members ?? []).filter((member) => !fleetMembers.includes(member)),
          };
        })
        .filter((binding) => (binding.members ?? []).length > 0);

      await client.setIamPolicy({ resource, policy: { ...policy, bindings: next } });

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
