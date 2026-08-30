# Kill-switch fire test

**Current status: the switch works.** A **live** fire against the real deployment on
**2026-08-30** (project `all-thinkgs`, region `us-central1`) engaged every stage — public
door shut, GPU held at zero instances by Cloud Run itself, and the fleet's own service
accounts stripped of the right to call the GPU — in under two seconds, from one delivery,
with no redelivery loop. Japanese version: [kill-switch.ja.md](./kill-switch.ja.md).

The single line that proves it is Cloud Run's own log for `gemma-serving`:

```
2026-08-30T14:12:51.128284Z  Shutting down user disabled instance
```

That is the platform reporting that it stopped the instance because the service was set to
hold at zero. No previous fire in this project's history produced anything like it.

This was not a unit test. `just kill-switch-test publish` puts a real over-budget
notification on the real `billing-kill-switch` topic, which reaches the real push
subscription with a real OIDC token. The fleet really went offline.

A [resolved postmortem of the 2026-08-27 fire](#resolved-postmortem-the-2026-08-27-fire),
which failed, is kept at the bottom of this document.

## What was fired

```
just kill-switch-test publish
# published 2026-08-30T14:12:39Z, messageId 21507257514954541
{"budgetDisplayName":"agentic-fleet-kill-switch","costAmount":60,
 "budgetAmount":50,"currencyCode":"USD","alertThresholdExceeded":1.0}
```

## Before

| Check                              | Value                                              |
| ---------------------------------- | -------------------------------------------------- |
| `gemma-serving` service `scaling`  | `scalingMode: automatic`, no `manualInstanceCount` |
| `gemma-serving` `template.scaling` | `maxInstanceCount: 1`                              |
| `gemma-serving` `run.invoker`      | `sa-gateway@…` **and** `sa-synthesis@…`            |
| `gateway-agent` IAM                | `allUsers` → `roles/run.invoker` present           |
| `just smoke`                       | passing, `core_actor: core_agent/gemini-3.5-flash` |

## What the switch did

Three mutations, in order, all idempotent, all inside ~2 seconds of one delivery
(`just logs-kill-switch`):

```
2026-08-30T14:12:42.225Z  WARNING  killswitch.triggered               budget_ratio 1.2, cost 60, budget 50
2026-08-30T14:12:42.702Z  INFO     killswitch.invoker_revoked         already_applied false
2026-08-30T14:12:43.228Z  INFO     killswitch.scaled_to_zero          already_applied false
2026-08-30T14:12:43.677Z  INFO     killswitch.fleet_invokers_revoked  already_applied false
2026-08-30T14:12:44.137Z  WARNING  killswitch.mark_failed             error_class "Error"
2026-08-30T14:12:44.137Z  INFO     killswitch.completed               already_applied false
```

1. **`revokePublicInvoker('gateway-agent')`** — drop the `allUsers` `roles/run.invoker`
   binding. The public door.
2. **`scaleToZero('gemma-serving')`** — set the **service-level** `scaling.scalingMode =
MANUAL` with `scaling.manualInstanceCount = 0`. This is Cloud Run's documented mechanism
   for holding a service at zero instances. `template.scaling.maxInstanceCount` is now
   deliberately **left alone at 1**.
3. **`revokeFleetInvokers('gemma-serving')`** — strip the gateway's and synthesis's
   `roles/run.invoker` on the GPU service, so even a Cloud Run that somehow admitted a
   request would have nobody authorised to make it. The member list comes from the
   `KILL_SWITCH_FLEET_MEMBERS` env var that Terraform sets.

**Why not cap `template.scaling.maxInstanceCount` at 0** — the mechanism the 2026-08-27
fire used, and the reason it failed. Cloud Run's maximum instance count is an integer from
1 upward, and `RevisionScaling.maxInstanceCount` is a plain proto3 `int32` with no presence
tracking, so a `0` is not serialised at all. The server receives an **absent** field, which
means "no maximum" — the limit is **removed**, not set to zero. `ServiceScaling.manualInstanceCount`
is the one field in this area declared `proto3_optional` (synthetic oneof
`_manualInstanceCount`), so an explicit `0` is presence-tracked and survives the round
trip. That is what makes zero expressible at all, and it is why the switch now writes the
service-level manual count instead.

**Why not trust the write** — success is verified by reading the applied state back
**explicitly**, scaling mode _and_ manual count, never inferred from an absent field. An
empty or absent scaling block now fails with `scale_to_zero_not_applied`.

## After

Every row below was read back live after the fire.

| Check                                              | Value                                                                                   | Verdict                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `gemma-serving` service `scaling`                  | `{"scalingMode":"MANUAL","manualInstanceCount":0}`                                      | **explicit zero, present in the response**                                  |
| `gemma-serving` `template.scaling`                 | `{"maxInstanceCount":1}`                                                                | untouched, as intended                                                      |
| Console annotations                                | `run.googleapis.com/scalingMode: manual`, `run.googleapis.com/manualInstanceCount: '0'` | agrees with the API                                                         |
| `gemma-serving` IAM                                | `roles/run.invoker` binding **gone entirely**                                           | both fleet SAs removed; only `roles/run.admin` for `sa-kill-switch` remains |
| `gateway-agent` IAM                                | `allUsers` **removed**                                                                  | public door shut                                                            |
| Anonymous `GET /healthz`                           | `404`                                                                                   | see the note below — this probe does **not** evidence the closure           |
| `killswitch.triggered` count                       | exactly **one**                                                                         | no redelivery storm                                                         |
| Dead-letter `billing-kill-switch-dead-letter-hold` | empty                                                                                   | nothing was abandoned                                                       |

And, decisively, Cloud Run's own instance log for `gemma-serving`:

```
2026-08-30T14:12:51.128284Z  Shutting down user disabled instance
```

The distinction matters: the API read-back proves the _setting_ landed; this line proves
the _platform acted on it_ and took the GPU down. The 2026-08-27 mechanism could never
produce it, because it never actually asked Cloud Run to stop anything.

> **The `/healthz` probe is not evidence, and the 2026-08-27 proof was wrong to treat it
> as such.** `GET /healthz` on `privacy-gateway.kexi.dev` answers `404` whether the public
> door is open or shut — the route is registered in the Gateway, but requests to it never
> reach the container, so Google's frontend answers instead ("That's all we know"). It was
> re-measured on 2026-08-30 with the fleet fully restored and the `allUsers` binding back
> in place: still `404`. A probe that returns the same value in both states distinguishes
> nothing.
>
> The closure is evidenced by the IAM read-back in the table above — the `allUsers`
> binding is present before and absent after — which is the state the platform actually
> enforces. A future fire should probe `GET /` or `GET /v1/models` instead: both answer
> `200` while the door is open, which was verified on 2026-08-30 after the restore.

## Known rough edges

Two, both recorded rather than smoothed over. Neither affects the guarantee.

### 1. `killswitch.mark_failed` — the marker write reports failure but lands

```
2026-08-30T14:12:44.137Z  WARNING  killswitch.mark_failed  error_class "Error"
```

Writing the `kill-switch/tripped` annotation on `gateway-agent` reported a failure. It
**was in fact written**: the annotation read back as `2026-08-30T14:12:43.767Z` afterwards.
So the write landed and the confirmation reported failure — the same class of misleading
long-running-operation behaviour that the scaling path already handles by re-reading its
own state.

Tolerated by design: it is logged at `WARNING` and the trip is **not** rolled back. **Why
not fail the request here** — refusing after all three mutations have succeeded would turn
a successful trip into a redelivery loop, which is exactly the failure mode the marker
exists to prevent. And the marker is present, so a redelivery is a no-op regardless.

Impact on the guarantee: none. The trip fully engaged.

### 2. Restore needs a second `terraform apply`

See [Restore](#restore) below. `terraform apply` errors on `gemma-serving` with
`Container failed to become healthy. Startup probes timed out after 11m` — a
**pre-existing** condition dating to 2026-08-28, unrelated to the kill switch: the GPU
revision cannot pass its startup probe on this deployment. The scaling change still lands,
but the error **aborts the apply before the invoker bindings are recreated**, so a second
`terraform apply` (or `-target=google_cloud_run_v2_service_iam_member.invoker`) is needed
to finish. Operational note for `just restore-after-kill`: expect to run it twice until the
startup-probe condition is fixed.

## Restore

All verified after the fire.

| Check                             | Value                                                     |
| --------------------------------- | --------------------------------------------------------- |
| `gateway-agent` IAM               | `allUsers` → `roles/run.invoker` re-asserted              |
| `gemma-serving` service `scaling` | `{"scalingMode":"AUTOMATIC","maxInstanceCount":1}`        |
| `gemma-serving` `run.invoker`     | both fleet bindings recreated                             |
| `kill-switch/tripped` marker      | cleared, read back **absent** — the switch is armed again |
| `just smoke`                      | passing, `core_actor: core_agent/gemini-3.5-flash`        |

Terraform re-asserted exactly what the switch had changed — the argument for Terraform as
the restore path holds up. The one caveat is the second-apply requirement described above.

## What this test establishes

- The switch **detects** correctly: `costAmount 60 >= budgetAmount 50`, ratio 1.2.
- The switch **closes the public door**: the `allUsers` invoker binding is gone, read back
  from IAM. (Not the `/healthz` probe — see the note above for why that one proves nothing.)
- The switch **stops the GPU**, and Cloud Run says so in its own words:
  `Shutting down user disabled instance`.
- The switch **removes the fleet's authority** to call the GPU, so the stop is defended at
  two layers, not one.
- Delivery is **terminal**: one notification, one trip, no loop, empty dead-letter hold.
- Restore is **complete and re-arms the switch**, with one documented operational wrinkle.

---

## Resolved postmortem: the 2026-08-27 fire

Kept because the diagnosis is worth having. **Everything in this section is fixed**; the
current code does not behave this way. The mechanism described here has been replaced
wholesale by the service-level manual-zero mechanism proven above.

### What happened

The 2026-08-27 fire recorded, honestly, a half-working switch:

```json
{"t":"2026-08-27T23:23:03.649Z","ev":"killswitch.triggered","cost":60,"budget":50,"ratio":1.2}
{"t":"2026-08-27T23:23:04.212Z","ev":"killswitch.invoker_revoked","already_applied":false}
{"t":"2026-08-27T23:23:09.639Z","ev":"killswitch.failed","error_class":"Error"}
```

| Check                    | Value                          | Verdict                       |
| ------------------------ | ------------------------------ | ----------------------------- |
| `gateway-agent` IAM      | `allUsers` binding **removed** | as designed                   |
| Anonymous `GET /healthz` | `404`                          | claimed as "public door shut" |
| `gemma-serving` maxScale | **still `1`**                  | **the GPU cap did not apply** |

The `/healthz` row is recorded as it was written at the time, but it did not support the
conclusion drawn from it: that endpoint answers `404` in both states. The closure was real
on 2026-08-27 — the IAM row above is what showed it — but the probe was not what showed it.

Half the switch worked. The half that protects the public endpoint fired correctly and
fast. The half that stops the expensive thing — the GPU — did not.

### Root cause: `maxInstanceCount = 0` removes the limit, it does not set it

The old `scaleToZero` wrote `template.scaling.maxInstanceCount = 0` (and
`scaling.maxInstanceCount = 0`). That was wrong twice over.

**First**, Cloud Run's maximum instance count is an integer from 1 upward.
`RevisionScaling.maxInstanceCount` is a plain proto3 `int32` with **no presence tracking**,
so a `0` is not serialised at all. The server receives an **absent** field, and an absent
maximum means **no maximum**. The write removed the limit rather than setting it to zero —
the opposite of the intent.

**Second**, and worse, the success check then read that **same absent field** back and
called it a zero cap. A "0 or unset" success condition is unfalsifiable when 0 and unset
are the same wire representation. So the switch reported a stopped GPU while nothing had
stopped it.

An addendum written on 2026-08-28 claimed this was fixed. It was not: that "fix" was the
same broken mechanism plus the false-success check that accepted the absent field. That
claim is retracted here rather than left standing.

The real fix was to stop trying to express zero in a field that cannot hold it. See
[What the switch did](#what-the-switch-did): the switch now sets the service-level
`scalingMode: MANUAL` with `manualInstanceCount: 0`, the one field declared
`proto3_optional`, and verifies both values explicitly on read-back.

### Second finding: the failure became an infinite revoke loop

The push endpoint answered `500` on a failed action so Pub/Sub would redeliver — the
comment reasoned that the mutations are idempotent, so a retry "finishes the half that
failed and no-ops the half that did not". But `scaleToZero` could never succeed, so the
handler returned `500` forever, and **every redelivery re-ran `revokePublicInvoker`**.

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
against an operator restoring in parallel** — so recovery was impossible until the
retention window drained.

**Fixed.** Delivery is now terminal: the endpoint acknowledges (2xx) even a failed trip, a
`kill-switch/tripped` annotation makes a redelivery a no-op, and a dead-letter policy
bounds any transport-level retry the application cannot answer its way out of. The
2026-08-30 fire produced **exactly one** `killswitch.triggered` and an empty dead-letter
hold — see [After](#after).

**Why not keep the 500-for-redelivery design** — it can only help when the failure is
transient, and it is unbounded when the failure is not. An ERROR log is the operator's
signal; a retry storm that fights the operator's restore is not.

### Diagnostics that still hold

These findings from the 2026-08-27/28 investigation remain true and are the reason the
current mechanism has the IAM grants it does.

- **`updateService` returns a long-running operation.** The original code resolved when the
  LRO _started_, so rejections surfaced outside the `try` that was meant to catch them.
  `setIamPolicy`, by contrast, returns the policy directly with no operation to await —
  which is exactly why the invoker revocation worked while the scaling change did not.
- **The operation's rejection is not the verdict.** On this GPU service the operation can
  report failure while the change still lands. The service's own state, read one call
  later, is what decides — it is the thing that costs money. The current
  `killswitch.mark_failed` rough edge is the same phenomenon on the annotation write.
- **Artifact Registry read is required.** A Cloud Run service _update_ re-validates the
  container image, so the caller needs
  `artifactregistry.repositories.downloadArtifacts` even when the update touches nothing
  but scaling. `roles/run.admin` does not imply it — run.admin governs the Cloud Run
  resource, not the registry the image lives in. Granted as `roles/artifactregistry.reader`.
- **`actAs` on the runtime identities is required.** Updating a service means assigning it
  a runtime service account, so the caller must be able to act as it even when the identity
  is unchanged — `roles/iam.serviceAccountUser` on `sa-gemma` and on `sa-gateway`
  (for the marker write), scoped to those accounts and not project-wide. **Why not
  project-wide** — the invoker revocations are `setIamPolicy` calls and need no `actAs` at
  all, so a broad grant would buy nothing and widen the blast radius of a compromised
  `sa-kill-switch`.

All are declared in `infra/terraform/killswitch.tf`.

---

## Resolved finding: `restore-after-kill` left the switch permanently disarmed

Found and fixed while running the 2026-08-30 restore. It is recorded because it was a
**silent** failure of the recovery path, which is the worst place to have one.

`just restore-after-kill` cleared the `kill-switch/tripped` marker with:

```
gcloud run services update ... --remove-annotations ... || echo "(no marker was set)"
```

`--remove-annotations` **does not exist** — gcloud rejects it as an unrecognised flag. The
`|| echo` swallowed that rejection and printed a message asserting the opposite of what had
happened: it said no marker was set, when in fact the marker was still set and the clear
had never run.

The consequence is severe out of proportion to the typo. A set marker makes every later
trip a no-op, so the operator would have walked away from a "successful" restore with the
kill switch **permanently disarmed**, and would have found out at the next real overspend.

Fixed: the recipe now clears the marker by read-modify-write on the v2 Service via the
Admin API, and **reads it back to confirm it is absent**. Verified on 2026-08-30 — the
marker read back absent and the switch is armed.

**Why not keep the `|| echo` fallback** — a recovery step that cannot distinguish "nothing
to do" from "the command does not work" is worse than no message at all, because it
converts a loud failure into a confident false reassurance. Every clear now ends in a
read-back.
