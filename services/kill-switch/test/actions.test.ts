/**
 * What the Cloud Run mutations guarantee.
 *
 * The handler tests prove the decision; these prove the two operations really
 * are no-ops once the desired state is reached, and that removing the public
 * binding does not disturb the service-to-service bindings the fleet needs to
 * keep working after the switch fires.
 */

import type { ServicesClient } from '@google-cloud/run';
import { describe, expect, it } from 'vitest';
import { cloudRunActions } from '../src/actions.ts';

const PROJECT = 'all-thinkgs';
const REGION = 'us-central1';
const GATEWAY = 'projects/all-thinkgs/locations/us-central1/services/gateway-agent';

/** Minimal ServicesClient double: only the four methods the actions call. */
function fakeClient(state: {
  policy?: Record<string, unknown>;
  service?: Record<string, unknown>;
}): {
  client: ServicesClient;
  setPolicyCalls: Record<string, unknown>[];
  updateCalls: Record<string, unknown>[];
} {
  const setPolicyCalls: Record<string, unknown>[] = [];
  const updateCalls: Record<string, unknown>[] = [];

  const client = {
    getIamPolicy: (_req: unknown) => Promise.resolve([state.policy ?? {}]),
    setIamPolicy: (req: Record<string, unknown>) => {
      setPolicyCalls.push(req);
      state.policy = req['policy'] as Record<string, unknown>;
      return Promise.resolve([state.policy]);
    },
    getService: (_req: unknown) => Promise.resolve([state.service ?? {}]),
    updateService: (req: Record<string, unknown>) => {
      updateCalls.push(req);
      state.service = req['service'] as Record<string, unknown>;
      return Promise.resolve([{}]);
    },
  } as unknown as ServicesClient;

  return { client, setPolicyCalls, updateCalls };
}

describe('revokePublicInvoker', () => {
  it('removes only allUsers, keeping the service-to-service invokers', async () => {
    const state = {
      policy: {
        etag: 'abc',
        bindings: [
          {
            role: 'roles/run.invoker',
            members: ['allUsers', 'serviceAccount:sa-gateway@all-thinkgs.iam.gserviceaccount.com'],
          },
        ],
      },
    };
    const { client, setPolicyCalls } = fakeClient(state);

    const outcome = await cloudRunActions({
      project: PROJECT,
      region: REGION,
      client,
    }).revokePublicInvoker('gateway-agent');

    expect(outcome).toEqual({ alreadyApplied: false });
    expect(setPolicyCalls[0]?.['resource']).toBe(GATEWAY);
    expect(setPolicyCalls[0]?.['policy']).toMatchObject({
      // The etag is carried through, so a concurrent policy write fails the
      // call instead of being silently overwritten.
      etag: 'abc',
      bindings: [
        {
          role: 'roles/run.invoker',
          members: ['serviceAccount:sa-gateway@all-thinkgs.iam.gserviceaccount.com'],
        },
      ],
    });
  });

  it('drops a binding that allUsers was the only member of', async () => {
    const state = {
      policy: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
    };
    const { client, setPolicyCalls } = fakeClient(state);

    await cloudRunActions({ project: PROJECT, region: REGION, client }).revokePublicInvoker(
      'gateway-agent',
    );

    // An empty member list is invalid input to setIamPolicy, so the binding
    // goes rather than being sent as an empty one.
    expect(setPolicyCalls[0]?.['policy']).toMatchObject({ bindings: [] });
  });

  it('is a no-op when the public binding is already gone', async () => {
    const state = {
      policy: { bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:x@y.com'] }] },
    };
    const { client, setPolicyCalls } = fakeClient(state);

    const outcome = await cloudRunActions({
      project: PROJECT,
      region: REGION,
      client,
    }).revokePublicInvoker('gateway-agent');

    expect(outcome).toEqual({ alreadyApplied: true });
    expect(setPolicyCalls).toEqual([]);
  });

  it('is a no-op on a policy with no bindings at all', async () => {
    const { client, setPolicyCalls } = fakeClient({ policy: {} });

    const outcome = await cloudRunActions({
      project: PROJECT,
      region: REGION,
      client,
    }).revokePublicInvoker('gateway-agent');

    expect(outcome).toEqual({ alreadyApplied: true });
    expect(setPolicyCalls).toEqual([]);
  });
});

describe('scaleToZero', () => {
  it('forces maxInstanceCount to zero, preserving the rest of the template', async () => {
    const state = {
      service: {
        name: 'gemma-serving',
        template: {
          serviceAccount: 'sa-gemma@all-thinkgs.iam.gserviceaccount.com',
          scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
        },
      },
    };
    const { client, updateCalls } = fakeClient(state);

    const outcome = await cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero(
      'gemma-serving',
    );

    expect(outcome).toEqual({ alreadyApplied: false });
    expect(updateCalls[0]?.['service']).toMatchObject({
      name: 'gemma-serving',
      template: {
        // Everything else survives, so restoring the service is a max-instances
        // change rather than a rebuild.
        serviceAccount: 'sa-gemma@all-thinkgs.iam.gserviceaccount.com',
        scaling: { minInstanceCount: 0, maxInstanceCount: 0 },
      },
    });
  });

  it('is a no-op when the service is already capped at zero', async () => {
    const state = { service: { template: { scaling: { maxInstanceCount: 0 } } } };
    const { client, updateCalls } = fakeClient(state);

    const outcome = await cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero(
      'gemma-serving',
    );

    expect(outcome).toEqual({ alreadyApplied: true });
    expect(updateCalls).toEqual([]);
  });

  it('scales a service that declares no scaling block', async () => {
    const { client, updateCalls } = fakeClient({ service: { template: {} } });

    const outcome = await cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero(
      'gemma-serving',
    );

    expect(outcome).toEqual({ alreadyApplied: false });
    expect(updateCalls[0]?.['service']).toMatchObject({
      template: { scaling: { maxInstanceCount: 0 } },
    });
  });
});
