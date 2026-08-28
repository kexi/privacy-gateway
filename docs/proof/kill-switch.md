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
