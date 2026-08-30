/**
 * What the Cloud Run mutations guarantee.
 *
 * The handler tests prove the decision; these prove the mutations really are
 * no-ops once the desired state is reached, that the GPU is held at zero by a
 * mechanism that can express zero at all, and that a success is only ever
 * claimed from state the API explicitly reported.
 */

import type { ServicesClient } from '@google-cloud/run';
import { describe, expect, it } from 'vitest';
import { cloudRunActions, TRIPPED_ANNOTATION } from '../src/actions.ts';

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
    // Models the real shape: updateService starts a long-running operation and
    // returns a handle whose `promise()` resolves to the updated Service. The
    // previous double returned a bare object, which is why the un-awaited
    // operation in `scaleToZero` passed its tests and still failed in flight.
    updateService: (req: Record<string, unknown>) => {
      updateCalls.push(req);
      const service = req['service'] as Record<string, unknown>;
      state.service = service;
      // The server echoes the applied object back. The action deliberately does
      // not trust that echo — it re-reads — and several tests below make the
      // echo lie to prove it.
      return Promise.resolve([{ promise: () => Promise.resolve([service]) }]);
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

/** The shape the real gemma-serving returns before the switch fires. */
function gemmaService(): Record<string, unknown> {
  return {
    name: 'gemma-serving',
    // Read from the live service: automatic scaling, one instance at most.
    // `scalingMode` is absent, which the API reads as AUTOMATIC.
    scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
    template: {
      serviceAccount: 'sa-gemma@all-thinkgs.iam.gserviceaccount.com',
      nodeSelector: { accelerator: 'nvidia-rtx-pro-6000' },
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
    },
  };
}

describe('scaleToZero', () => {
  it('switches the service to manual scaling with an explicit zero count', async () => {
    const { client, updateCalls } = fakeClient({ service: gemmaService() });

    const outcome = await cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero(
      'gemma-serving',
    );

    expect(outcome).toEqual({ alreadyApplied: false });
    // The exact request shape is pinned, because the defect this replaces was a
    // request shape: `maxInstanceCount: 0` is not a zero cap, it is an absent
    // field, and Cloud Run reads an absent maximum as "no maximum at all".
    // `scaling.manualInstanceCount` is the one field here that is
    // `proto3_optional`, so an explicit 0 survives the round trip.
    expect(updateCalls[0]?.['service']).toMatchObject({
      name: 'gemma-serving',
      scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
      template: {
        // Everything else survives, so restoring the service is a scaling-mode
        // change rather than a rebuild. The GPU node selector in particular must
        // come back untouched.
        serviceAccount: 'sa-gemma@all-thinkgs.iam.gserviceaccount.com',
        nodeSelector: { accelerator: 'nvidia-rtx-pro-6000' },
      },
    });
  });

  it('leaves the revision maximum alone rather than writing a zero into it', async () => {
    // Writing 0 there does not cap the service at zero; it removes the maximum.
    const { client, updateCalls } = fakeClient({ service: gemmaService() });

    await cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero(
      'gemma-serving',
    );

    const sent = updateCalls[0]?.['service'] as {
      template?: { scaling?: { maxInstanceCount?: number } };
    };
    expect(sent.template?.scaling?.maxInstanceCount).toBe(1);
  });

  it('waits for the update operation instead of only starting it', async () => {
    // The defect this pins: updateService returns a long-running operation, and
    // the original code awaited only the call that started it. It therefore
    // reported success while gemma-serving kept serving.
    let settled = false;
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const started = client as unknown as { updateService: unknown };
    const inner = started.updateService as (req: Record<string, unknown>) => Promise<unknown[]>;
    started.updateService = (req: Record<string, unknown>) =>
      inner(req).then(() => [
        {
          promise: () =>
            new Promise((resolve) => {
              setTimeout(() => {
                settled = true;
                resolve([req['service']]);
              }, 5);
            }),
        },
      ]);

    await cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero(
      'gemma-serving',
    );

    expect(settled).toBe(true);
  });

  it('fails when the service still reports automatic scaling afterwards', async () => {
    // A cost gate must not report success while the GPU can still start: that
    // is the one outcome that keeps costing money. Here the update is accepted
    // but changes nothing, which is the silent failure worth catching.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const stubborn = client as unknown as { updateService: unknown };
    stubborn.updateService = () =>
      Promise.resolve([{ promise: () => Promise.resolve([state.service]) }]);

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).rejects.toThrow('scale_to_zero_not_applied');
  });

  it('refuses to call an absent scaling block a capped GPU', async () => {
    // The exact false success this replaces. The old check treated a missing
    // field as proof of a zero cap; an empty read-back now fails, because
    // nothing about it says the service is held at zero.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const omitting = client as unknown as { updateService: unknown };
    omitting.updateService = () => {
      state.service = { name: 'gemma-serving', template: {} };
      return Promise.resolve([{ promise: () => Promise.resolve([state.service]) }]);
    };

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).rejects.toThrow('scale_to_zero_not_applied');
  });

  it('refuses manual mode with a non-zero count', async () => {
    // Manual scaling alone is not the guarantee; manual scaling *at zero* is.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const partial = client as unknown as { updateService: unknown };
    partial.updateService = () => {
      state.service = { name: 'gemma-serving', scaling: { scalingMode: 'MANUAL' } };
      return Promise.resolve([{ promise: () => Promise.resolve([state.service]) }]);
    };

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).rejects.toThrow('scale_to_zero_not_applied');
  });

  it('confirms with a fresh read, not the operation result', async () => {
    // Observed live on 2026-08-28: the LRO's own result can still carry the
    // pre-update scaling on a fast update, even though the change really
    // applied. Trusting it made a successful trip report failure.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const stale = client as unknown as { updateService: unknown };
    stale.updateService = (req: Record<string, unknown>) => {
      state.service = req['service'] as Record<string, unknown>;
      // The echo lies; the subsequent getService tells the truth.
      return Promise.resolve([
        { promise: () => Promise.resolve([{ scaling: { scalingMode: 'AUTOMATIC' } }]) },
      ]);
    };

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).resolves.toEqual({ alreadyApplied: false });
  });

  it('accepts the numeric enum form the client may return', async () => {
    // `ScalingMode.MANUAL` is 2. Writing the string and reading back the number
    // must not look like a failed trip.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const numeric = client as unknown as { updateService: unknown };
    numeric.updateService = () => {
      state.service = {
        name: 'gemma-serving',
        scaling: { scalingMode: 2, manualInstanceCount: 0 },
      };
      return Promise.resolve([{ promise: () => Promise.resolve([state.service]) }]);
    };

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).resolves.toEqual({ alreadyApplied: false });
  });

  it('succeeds when the operation rejects but the scaling change was applied anyway', async () => {
    // The live GPU behaviour, reproduced: the operation reports a failure (the
    // new revision is being told to run zero instances) while the scaling change
    // itself lands. Treating that rejection as the verdict re-arms the
    // operator's alarm for a fleet that is already stopped.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const failing = client as unknown as { updateService: unknown };
    failing.updateService = (req: Record<string, unknown>) => {
      state.service = req['service'] as Record<string, unknown>;
      return Promise.resolve([
        { promise: () => Promise.reject(new Error('Revision is not ready')) },
      ]);
    };

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).resolves.toEqual({ alreadyApplied: false });
  });

  it("surfaces the operation's error when the change really did not apply", async () => {
    // Both went wrong: the operation failed *and* nothing changed. The
    // operation's own error is the more useful one to report, because it says
    // why.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const failing = client as unknown as { updateService: unknown };
    failing.updateService = () =>
      Promise.resolve([{ promise: () => Promise.reject(new Error('quota exhausted')) }]);

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).rejects.toThrow('quota exhausted');
  });

  it('is a no-op when the service is already held at manual zero', async () => {
    const state = {
      service: { scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 } },
    };
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
      scaling: { scalingMode: 'MANUAL', manualInstanceCount: 0 },
    });
  });
});

describe('revokeFleetInvokers', () => {
  const FLEET = [
    'serviceAccount:sa-gateway@all-thinkgs.iam.gserviceaccount.com',
    'serviceAccount:sa-synthesis@all-thinkgs.iam.gserviceaccount.com',
  ];
  const GEMMA = 'projects/all-thinkgs/locations/us-central1/services/gemma-serving';

  it('removes exactly the configured fleet members and nothing else', async () => {
    const state = {
      policy: {
        etag: 'xyz',
        bindings: [
          {
            role: 'roles/run.invoker',
            members: [...FLEET, 'serviceAccount:sa-operator@all-thinkgs.iam.gserviceaccount.com'],
          },
          { role: 'roles/run.viewer', members: FLEET },
        ],
      },
    };
    const { client, setPolicyCalls } = fakeClient(state);

    const outcome = await cloudRunActions({
      project: PROJECT,
      region: REGION,
      fleetMembers: FLEET,
      client,
    }).revokeFleetInvokers('gemma-serving');

    expect(outcome).toEqual({ alreadyApplied: false });
    expect(setPolicyCalls[0]?.['resource']).toBe(GEMMA);
    expect(setPolicyCalls[0]?.['policy']).toMatchObject({
      etag: 'xyz',
      bindings: [
        {
          role: 'roles/run.invoker',
          members: ['serviceAccount:sa-operator@all-thinkgs.iam.gserviceaccount.com'],
        },
        // Only the invoker role is touched: revoking a fleet member's ability to
        // read the service would be a different, unasked-for change.
        { role: 'roles/run.viewer', members: FLEET },
      ],
    });
  });

  it('drops an invoker binding the fleet was the only member of', async () => {
    const state = { policy: { bindings: [{ role: 'roles/run.invoker', members: FLEET }] } };
    const { client, setPolicyCalls } = fakeClient(state);

    await cloudRunActions({
      project: PROJECT,
      region: REGION,
      fleetMembers: FLEET,
      client,
    }).revokeFleetInvokers('gemma-serving');

    expect(setPolicyCalls[0]?.['policy']).toMatchObject({ bindings: [] });
  });

  it('is a no-op once the fleet bindings are gone, so a redelivery costs one read', async () => {
    const state = {
      policy: { bindings: [{ role: 'roles/run.invoker', members: ['serviceAccount:x@y.com'] }] },
    };
    const { client, setPolicyCalls } = fakeClient(state);

    const outcome = await cloudRunActions({
      project: PROJECT,
      region: REGION,
      fleetMembers: FLEET,
      client,
    }).revokeFleetInvokers('gemma-serving');

    expect(outcome).toEqual({ alreadyApplied: true });
    expect(setPolicyCalls).toEqual([]);
  });

  it('does nothing when no fleet members are configured', async () => {
    const state = { policy: { bindings: [{ role: 'roles/run.invoker', members: FLEET }] } };
    const { client, setPolicyCalls } = fakeClient(state);

    const outcome = await cloudRunActions({
      project: PROJECT,
      region: REGION,
      client,
    }).revokeFleetInvokers('gemma-serving');

    expect(outcome).toEqual({ alreadyApplied: true });
    expect(setPolicyCalls).toEqual([]);
  });
});

describe('the tripped marker', () => {
  it('reports an untripped service as not tripped', async () => {
    const { client } = fakeClient({ service: { name: 'gateway-agent' } });

    expect(
      await cloudRunActions({ project: PROJECT, region: REGION, client }).isTripped(
        'gateway-agent',
      ),
    ).toBe(false);
  });

  it('records the marker as an annotation, keeping the existing ones', async () => {
    const state = {
      service: { name: 'gateway-agent', annotations: { 'example.com/keep': 'yes' } },
    };
    const { client, updateCalls } = fakeClient(state);

    await cloudRunActions({ project: PROJECT, region: REGION, client }).markTripped(
      'gateway-agent',
    );

    const written = updateCalls[0]?.['service'] as
      | { annotations: Record<string, string> }
      | undefined;
    const annotations = written?.annotations ?? {};
    expect(annotations['example.com/keep']).toBe('yes');
    // The value is a timestamp, so an operator sees when without the logs.
    expect(Date.parse(annotations[TRIPPED_ANNOTATION] ?? '')).not.toBeNaN();
  });

  it('reads back as tripped once marked, so a redelivery is a no-op', async () => {
    const { client } = fakeClient({ service: { name: 'gateway-agent' } });
    const actions = cloudRunActions({ project: PROJECT, region: REGION, client });

    await actions.markTripped('gateway-agent');

    expect(await actions.isTripped('gateway-agent')).toBe(true);
  });
});
