# Kill-switch fire test

A **live** fire of the cost kill switch against the real deployment on **2026-08-27**
(project `all-thinkgs`, region `us-central1`). Japanese version:
[kill-switch.ja.md](./kill-switch.ja.md).

This was not a unit test. `just kill-switch-test publish` puts a real over-budget
notification on the real `billing-kill-switch` topic, which reaches the real push
subscription with a real OIDC token. The fleet really went offline.

## What was fired

```
just kill-switch-test publish
# published messageId 21095725789802462
{"budgetDisplayName":"agentic-fleet-kill-switch","costAmount":60,
 "budgetAmount":50,"currencyCode":"USD","alertThresholdExceeded":1.0}
```

## Before

| Check                    | Value                                    |
| ------------------------ | ---------------------------------------- |
| `gateway-agent` IAM      | `allUsers` → `roles/run.invoker` present |
| `gemma-serving` maxScale | `1`                                      |
| Anonymous `GET /`        | `200`                                    |

## What the switch did

`just logs-kill-switch`, first delivery:

```json
{"t":"2026-08-27T23:23:03.649Z","ev":"killswitch.triggered","cost":60,"budget":50,"ratio":1.2}
{"t":"2026-08-27T23:23:04.212Z","ev":"killswitch.invoker_revoked","already_applied":false}
{"t":"2026-08-27T23:23:09.639Z","ev":"killswitch.failed","error_class":"Error"}
```

## After

| Check                    | Value                          | Verdict                       |
| ------------------------ | ------------------------------ | ----------------------------- |
| `gateway-agent` IAM      | `allUsers` binding **removed** | as designed                   |
| Anonymous `GET /healthz` | `404`                          | public door shut              |
| `gemma-serving` maxScale | **still `1`**                  | **the GPU cap did not apply** |

So **half the switch worked.** The half that protects the public endpoint fired
correctly and fast. The half that stops the expensive thing — the GPU — did not.

## Finding 1: `scaleToZero` fails against the GPU service

`killswitch.triggered` and `killswitch.invoker_revoked` are followed every time by
`killswitch.failed`, and `gemma-serving` keeps `maxInstanceCount = 1`. The kill switch
revokes public access but never caps the GPU, which is the cost it exists to stop.

The cause is not visible in the logs by design: the project's logging policy records
`error_class` only, never an exception message, so the failure surfaces as a bare
`{"error_class":"Error"}`. The suspect is `scaleToZero` in
`services/kill-switch/src/actions.ts`, which reads the whole Service and writes it back
with only `template.scaling` changed:

```ts
await client.updateService({
  service: {
    ...current,
    template: { ...current.template, scaling: { ...scaling, maxInstanceCount: 0 } },
  },
});
```

A full-object write echoes back output-only and GPU-specific fields
(`nodeSelector: nvidia-rtx-pro-6000`, `nvidia.com/gpu: 1`, the zonal-redundancy
annotation) that the v2 API may reject on update. The comment above it explains why an
update mask was rejected as the riskier option; on this GPU service the trade appears to
have gone the wrong way. **Not yet root-caused**: reproducing it needs a direct
`updateService` call, which was outside what this session was permitted to run.

## Finding 2: the failure becomes an infinite revoke loop

This is the more serious consequence, and it is what made the restore hard.

The push endpoint answers `500` on a failed action so Pub/Sub redelivers — deliberate,
and the comment says the mutations are idempotent so a retry "finishes the half that
failed and no-ops the half that did not". But `scaleToZero` never succeeds, so the
handler returns `500` forever, and **every redelivery re-runs `revokePublicInvoker`**.

Observed: a trigger every ~30 s for ~11 minutes, until the subscription's 600 s
`messageRetentionDuration` expired at ~23:34.

```json
{"t":"2026-08-27T23:23:44.313Z","ev":"killswitch.invoker_revoked","already_applied":true}
{"t":"2026-08-27T23:24:34.314Z","ev":"killswitch.invoker_revoked","already_applied":true}
{"t":"2026-08-27T23:25:55.577Z","ev":"killswitch.invoker_revoked","already_applied":false}  <- operator had restored it; switch took it away again
...
{"t":"2026-08-27T23:33:57.393Z","ev":"killswitch.triggered"}
```

The `already_applied: false` at 23:25:55 is the loop fighting the operator: a
`just tf-apply` had just restored the binding, and the next redelivery removed it again.
The mutations are individually idempotent, but **revoke-then-restore is not idempotent
against an operator restoring in parallel** — so recovery is impossible until the
retention window drains. There is no dead-letter policy on
`billing-kill-switch-push` to stop it earlier.

## Restore

Attempting `tf-apply` during the loop restored the binding and lost it again within
~30 s. The restore only held after redelivery stopped:

```
# after ~23:37, redelivery drained
just tf-apply    # (restore-after-kill wraps this)
google_cloud_run_v2_service_iam_member.gateway_public: Creation complete after 8s
Apply complete! Resources: 1 added, 0 changed, 0 destroyed.
```

Terraform re-created exactly the one binding the switch had removed — the argument for
Terraform as the restore path holds up.

| Check               | Value                                 |
| ------------------- | ------------------------------------- |
| `gateway-agent` IAM | `allUsers` → `roles/run.invoker` back |
| `GET /v1/models`    | `200`                                 |
| `gemma-serving`     | maxScale `1` (never changed)          |

IAM propagation took ~40 s: `/v1/models` answered `403` for three probes after the apply
reported success, then `200`. Worth knowing before concluding a restore failed.

## What this test establishes

- The switch **detects** correctly: `costAmount 60 >= budgetAmount 50`, ratio 1.2.
- The switch **closes the public door** correctly and quickly (~1 s from delivery).
- The switch **does not cap the GPU**, which is the spend it was built to stop.
- A partial failure **degrades into a revoke loop** that blocks operator recovery for
  the full 600 s retention window.

Both findings are open. Suggested fixes, not applied here:

1. Fix `scaleToZero` (likely a field mask, or strip output-only fields before the write),
   and add a check that asserts `maxInstanceCount` afterwards rather than trusting the call.
2. Make redelivery safe: record per-action success so a retry does not repeat an action
   that already succeeded, and/or add a dead-letter policy so a permanently failing
   message stops after N attempts instead of looping for the whole retention window.

---

## Addendum (2026-08-28): both findings fixed

Both root causes were found and fixed. The suspicion recorded above — that the v2 API
rejected the full-object write because of output-only or GPU-specific fields — **was
wrong**, and is corrected here rather than left standing.

### Finding 1 root cause: the long-running operation was never awaited

`updateService` in Cloud Run Admin v2 returns a **long-running operation**, not a
completed write. The old code did:

```ts
await client.updateService({ service: { ... } });   // resolves when the LRO STARTS
```

That resolves as soon as Cloud Run _accepts_ the request. The actual update was still in
flight — and any rejection surfaced later, outside the `try` block that was supposed to
catch it. So the handler reported success while `gemma-serving` kept
`maxInstanceCount = 1`. This is precisely why `revokePublicInvoker` worked and
`scaleToZero` did not: `setIamPolicy` returns the policy directly, with no operation to
await.

Evidence that the rejection hypothesis was wrong: replaying the exact full-object write
against the real service with `validateOnly: true` was **accepted**, output-only fields
and `nodeSelector: nvidia-rtx-pro-6000` included.

A second, independent bug was found while fixing it. Cloud Run v2 has **two** scaling
caps and the code only ever wrote one:

| Field                      | `gemma-serving` | `gateway-agent` |
| -------------------------- | --------------- | --------------- |
| `service.scaling`          | `1`             | `20`            |
| `service.template.scaling` | `1`             | `3`             |

They are genuinely independent. Capping only the revision-level one would have left the
service-level cap able to start the GPU, so the fix writes both.

The fix therefore does three things: writes both caps, awaits `operation.promise()`, and
**verifies the server's echo** rather than trusting the call — a completed operation that
did not apply the cap now throws `scale_to_zero_not_applied`.

### Finding 2 root cause: 500-for-redelivery, with nothing to stop it

The loop was the design working as written. The push endpoint answered `500` so Pub/Sub
would redeliver "and finish the half that failed", but the failing half could never
succeed, so every redelivery re-ran the half that had. Delivery is now **terminal**:

- The trip is recorded as a `kill-switch/tripped` annotation on `gateway-agent`, written
  only after **both** mutations are confirmed. A redelivery reads it and returns
  `already_tripped` without touching anything.
- The endpoint **acknowledges** (2xx) even a failed trip. One notification now causes at
  most one trip attempt; the ERROR log is the operator's signal, not a retry storm.
- A **dead-letter topic** (`billing-kill-switch-dead-letter`, `max_delivery_attempts = 5`)
  bounds any transport-level retry loop the application cannot answer its way out of.
  Read it with `just logs-kill-switch-dlq`.
- `just restore-after-kill` clears the marker after a successful apply, re-arming the
  switch. Clearing it last is deliberate: while it is set the switch will not fire, so
  removing it earlier would arm the switch against a fleet that is still down.

Why the marker fails _open_ on a read error: failing to stop a real overspend is worse
than acting twice, so an unreadable marker falls through to the trip.

### Two more root causes, found only by re-firing

The code fix alone was not enough. Re-firing against the real deployment exposed **two IAM
grants the switch never had**, each hidden behind the other, and both invisible before
because the un-awaited operation swallowed every rejection. The audit log
(`protoPayload.methodName="google.cloud.run.v2.Services.UpdateService"`) named them; the
service's own structured log could not, since it records `error_class` only.

**1. Artifact Registry read.** A Cloud Run service _update_ re-validates the container
image, so the caller must be able to read the repository even when the update touches
nothing but `scaling`:

```
PERMISSION_DENIED: Permission 'artifactregistry.repositories.downloadArtifacts'
denied on resource '.../repositories/agentic-fleet'
```

`roles/run.admin` does not imply it — run.admin governs the Cloud Run resource, not the
registry the image lives in. Fixed by granting `roles/artifactregistry.reader`.

**2. actAs on the GPU service's runtime identity.** Immediately behind it:

```
PERMISSION_DENIED: Permission 'iam.serviceaccounts.actAs' denied on service account
sa-gemma@all-thinkgs.iam.gserviceaccount.com
```

Updating a service means assigning it a runtime service account, so the caller must be able
to act as that account — even when the identity is unchanged. Fixed by granting
`roles/iam.serviceAccountUser` on `sa-gemma` alone (not project-wide). `sa-gateway` is
deliberately not granted: the gateway mutation is an IAM policy change, which needs no
actAs.

Both are now declared in `infra/terraform/killswitch.tf`.

### Two corrections to the fix itself, also from re-firing

**Only `template.scaling` is the real cap.** The addendum above claimed both scaling
fields had to be written. Writing both is harmless, but only `template.scaling` can be
asserted: it is what Cloud Run surfaces as `autoscaling.knative.dev/maxScale`, and it is
what the original fire measured as "still 1". The top-level `service.scaling` is the
newer _manual_ instance count, inert unless `scalingMode` selects manual scaling — and
proto3 cannot distinguish an explicit `0` from an unset field, so the server drops that
write and the value reads back as `1` forever. Requiring it to be zero made the action
throw on every trip even though the GPU was genuinely capped.

**The operation's rejection is not the verdict.** On this GPU service the operation
reports a failure while the scaling change still lands — the operation is really reporting
on the new revision coming up, and a GPU revision cannot start an instance when its own
maximum is zero. Measured:

```
01:38:49.191  UpdateService                     status=ok
01:38:49.535  killswitch.failed                 (the LRO rejected)
01:38:50.538  Ready condition True for gemma-serving-00010-4f2, cap = 0
```

So the operation is awaited (that part of the fix stands), but the **service's own state
one read later is what decides**, because it is the thing that costs money. A cost gate
that cries failure on a successful trip re-arms the operator's alarm for a fleet that is
already stopped. When the cap genuinely did not apply, the operation's error is reported
in preference to a bare assertion, because it explains why.

A zero reads back as an **absent** field, so "0 or unset" is the success condition.

**A third actAs grant, for the marker.** The first fully-successful trip then revealed one
more: writing the `kill-switch/tripped` annotation updates `gateway-agent`, so it needs
`actAs` on `sa-gateway` as well. Without it the trip succeeded and then failed to record
itself (`killswitch.mark_failed`) — which would have let a redelivery trip the fleet a
second time, the exact loop the marker exists to prevent. The invoker revocation itself
needs no actAs, because it is a `setIamPolicy` call rather than a service update.

## The switch fully engaging (2026-08-28)

The first fire in this project's history where **both** halves worked:

```json
{"t":"2026-08-28T01:51:17.917Z","ev":"killswitch.triggered"}
{"t":"2026-08-28T01:51:18.296Z","ev":"killswitch.invoker_revoked"}
{"t":"2026-08-28T01:51:18.898Z","ev":"killswitch.scaled_to_zero"}
{"t":"2026-08-28T01:51:24.228Z","ev":"killswitch.completed"}
```

| Check                      | Before  | After                  | Verdict               |
| -------------------------- | ------- | ---------------------- | --------------------- |
| `gateway-agent` `allUsers` | present | **revoked**            | public door shut      |
| `gemma-serving` maxScale   | `1`     | **`0`** (field absent) | **the GPU is capped** |
| Redelivery loop            | —       | **none**               | delivery terminal     |

Compare with the original fire, where `gemma-serving` kept `maxInstanceCount = 1` and the
handler logged `killswitch.failed` every ~30 s for 11 minutes.

### The loop is gone

Measured on the fire before this one, which still ended in `killswitch.failed` — the worst
case for the old design, because a permanent failure is exactly what looped:

```
01:06:15.932  killswitch.triggered
01:06:16.417  killswitch.invoker_revoked
01:06:21.948  killswitch.failed
   … nothing further through 01:08:43 (2.5 minutes)
```

Exactly **one** `triggered` and **one** `invoker_revoked`. Under the old 500-for-redelivery
design this window already showed three or four re-revocations. The endpoint now
acknowledges, so one notification causes one trip attempt regardless of outcome.
