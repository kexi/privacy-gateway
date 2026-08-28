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
      // The server echoes the applied object back, which is what the action
      // inspects to confirm the cap really took effect.
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

/** The shape the real gemma-serving returns: two independent scaling caps. */
function gemmaService(): Record<string, unknown> {
  return {
    name: 'gemma-serving',
    // Read from the live service: the service-level cap and the revision cap
    // are separate fields, and capping only one leaves the GPU able to start.
    // On gateway-agent they were observed as 20 and 3.
    scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
    template: {
      serviceAccount: 'sa-gemma@all-thinkgs.iam.gserviceaccount.com',
      nodeSelector: { accelerator: 'nvidia-rtx-pro-6000' },
      scaling: { minInstanceCount: 0, maxInstanceCount: 1 },
    },
  };
}

describe('scaleToZero', () => {
  it('caps both the service-level and the revision-level maximum', async () => {
    const { client, updateCalls } = fakeClient({ service: gemmaService() });

    const outcome = await cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero(
      'gemma-serving',
    );

    expect(outcome).toEqual({ alreadyApplied: false });
    expect(updateCalls[0]?.['service']).toMatchObject({
      name: 'gemma-serving',
      scaling: { minInstanceCount: 0, maxInstanceCount: 0 },
      template: {
        // Everything else survives, so restoring the service is a max-instances
        // change rather than a rebuild. The GPU node selector in particular must
        // come back untouched.
        serviceAccount: 'sa-gemma@all-thinkgs.iam.gserviceaccount.com',
        nodeSelector: { accelerator: 'nvidia-rtx-pro-6000' },
        scaling: { minInstanceCount: 0, maxInstanceCount: 0 },
      },
    });
  });

  it('waits for the update operation instead of only starting it', async () => {
    // The defect this pins: updateService returns a long-running operation, and
    // the original code awaited only the call that started it. It therefore
    // reported success while gemma-serving kept maxInstanceCount = 1.
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

  it('fails when the service still reports a non-zero cap afterwards', async () => {
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

  it('confirms with a fresh read, not the operation result', async () => {
    // Observed live on 2026-08-28: the LRO's own result can still carry the
    // pre-update scaling on a fast update, even though the cap really applied.
    // Trusting it made a successful trip report failure. The double reproduces
    // that exactly — a stale echo over state that did change.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const stale = client as unknown as { updateService: unknown };
    stale.updateService = (req: Record<string, unknown>) => {
      state.service = req['service'] as Record<string, unknown>;
      // The echo lies; the subsequent getService tells the truth.
      return Promise.resolve([
        { promise: () => Promise.resolve([{ template: { scaling: { maxInstanceCount: 1 } } }]) },
      ]);
    };

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).resolves.toEqual({ alreadyApplied: false });
  });

  it('accepts a confirmed state that omits the cap, because proto3 drops a zero', async () => {
    // How the real API reports a successful cap-to-zero: the field is absent.
    const state = { service: gemmaService() };
    const { client } = fakeClient(state);
    const omitting = client as unknown as { updateService: unknown };
    omitting.updateService = () => {
      state.service = { name: 'gemma-serving', template: {} };
      return Promise.resolve([{ promise: () => Promise.resolve([state.service]) }]);
    };

    await expect(
      cloudRunActions({ project: PROJECT, region: REGION, client }).scaleToZero('gemma-serving'),
    ).resolves.toEqual({ alreadyApplied: false });
  });

  it('succeeds when the operation rejects but the cap was applied anyway', async () => {
    // The live GPU behaviour, reproduced: the operation reports a failure (the
    // new revision cannot bring an instance up when its own maximum is zero)
    // while the scaling change itself lands. Observed 2026-08-28 — the LRO
    // rejected one second before Cloud Run logged the revision Ready with the
    // cap at zero. Treating that rejection as the verdict re-arms the
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

  it("surfaces the operation's error when the cap really did not apply", async () => {
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

  it('is a no-op when the revision cap is already zero', async () => {
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
      scaling: { maxInstanceCount: 0 },
      template: { scaling: { maxInstanceCount: 0 } },
    });
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
