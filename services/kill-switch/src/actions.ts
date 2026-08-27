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
}

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

      const scaling = current.template?.scaling;
      if (scaling?.maxInstanceCount === 0) return { alreadyApplied: true };

      // The whole Service message is sent back with only `scaling` changed.
      // Why not an update mask limited to the scaling field: Cloud Run v2's
      // updateService treats an absent field under a mask as "clear it", and a
      // partial mask on a nested message has repeatedly proved easier to get
      // wrong than a full-object write of a freshly-read object.
      await client.updateService({
        service: {
          ...current,
          template: {
            ...current.template,
            scaling: { ...scaling, maxInstanceCount: 0 },
          },
        },
      });

      return { alreadyApplied: false };
    },
  };
}
