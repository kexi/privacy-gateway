# Deploy Runbook

Project: `all-thinkgs` / Region: **`us-central1`** / Account: `kei.of.nakayama@gmail.com`

This document covers operating `infra/` and `serving/`. For the reasoning behind the
architecture see [ARCHITECTURE.md](./ARCHITECTURE.md); for the diagram see
[diagram/architecture.drawio.png](./diagram/architecture.drawio.png).

A Japanese version of this document is at [DEPLOY.ja.md](./DEPLOY.ja.md).

---

## 1. Region choice: why `us-central1`

**Conclusion: put everything (4 Cloud Run services + Firestore + Vertex AI) in `us-central1`.**

`asia-northeast1` (Tokyo) was the initial preference but had to be rejected, because
**Cloud Run GPU is not available in Tokyo**. As of 2026-08, Cloud Run supports the
NVIDIA L4 only in these regions:

| Region                        | L4     | Price tier |
| ----------------------------- | ------ | ---------- |
| `us-central1` (Iowa)          | yes    | Tier 1     |
| `us-east4` (N. Virginia)      | yes    | Tier 2     |
| `europe-west1` (Belgium)      | yes    | Tier 1     |
| `europe-west4` (Netherlands)  | yes    | Tier 1     |
| `asia-southeast1` (Singapore) | yes    | Tier 2     |
| `asia-northeast1` (Tokyo)     | **no** | Tier 1     |

Careful: `gcloud compute accelerator-types list` does report `nvidia-l4` in Tokyo, but
that is **Compute Engine**, which is a different list from the Cloud Run GPU regions.
Do not confuse the two.

Why `us-central1`:

1. **Cloud Run GPU is available** (the hard requirement, which narrows it to five regions)
2. **Tier 1 pricing** (`us-east4` and `asia-southeast1` are Tier 2, with higher CPU/memory rates)
3. **Best chance of getting GPU quota** (the largest L4 capacity of any region)
4. **Firestore and Vertex AI Gemini can live alongside it**, so every A2A hop and vault
   access stays in-region. No cross-region latency and no egress charges
5. It is also the region where new Vertex AI Gemini models land first

The trade-off: demoing from Japan adds roughly 100-150ms of round-trip latency. But the
dominant costs here are Gemma and Gemini inference (seconds), so the perceived impact is
small. **There is no option that avoids GPU-capable regions**, so this is accepted.

To change it, override the environment variable, e.g. `REGION=europe-west1 just deploy`.

---

## 2. Prerequisites

```bash
gcloud config set project all-thinkgs
gcloud config set account kei.of.nakayama@gmail.com
gcloud auth login
gcloud auth application-default login   # for local development
```

IAM needed by the operator: `roles/owner`, or
`run.admin` + `iam.serviceAccountAdmin` + `datastore.owner` + `artifactregistry.admin` +
`cloudbuild.builds.editor` + `serviceusage.serviceUsageAdmin`.

---

## 3. Steps

Every script uses `set -euo pipefail` and is **idempotent**. If one fails partway, fix the
cause and re-run the same command.

### 3.0 Check the configuration

```bash
source infra/common.sh && env | grep -E 'PROJECT_ID|REGION|GEMMA_MODEL'
```

Only export environment variables if you want to change a default
(for example `export GEMMA_MODEL=gemma3:4b`).

### 3.1 Enable APIs

```bash
just enable-apis
```

Enables: `run` / `compute` / `artifactregistry` / `cloudbuild` / `firestore` /
`aiplatform` / `iam` / `logging` / `cloudtrace`.

`compute.googleapis.com` is required because Direct VPC egress references the `default`
VPC (see 3.5); without it, subnet resolution fails.
(`all-thinkgs` is a new project, so this is where they get enabled for the first time.)

### 3.2 Service accounts and IAM

```bash
just iam
```

The service accounts and their permissions:

| SA             | Firestore             | Vertex AI         | run.invoker (granted to) | logging/trace |
| -------------- | --------------------- | ----------------- | ------------------------ | ------------- |
| `sa-gateway`   | `datastore.user`      | -                 | -                        | yes           |
| `sa-core`      | **none (deliberate)** | `aiplatform.user` | from gateway             | yes           |
| `sa-synthesis` | `datastore.user`      | -                 | from gateway             | yes           |
| `sa-gemma`     | -                     | -                 | from gateway / synthesis | yes           |

**Giving `sa-core` no Firestore role is the heart of this project.** The Core Agent being
unable to read the Token Vault is not a promise made in code; it is a fact enforced by IAM.
That is the pitch. The command to verify it during the demo:

```bash
gcloud projects get-iam-policy all-thinkgs \
  --flatten="bindings[].members" \
  --filter="bindings.members:sa-core@all-thinkgs.iam.gserviceaccount.com" \
  --format="value(bindings.role)"
# Expected: only roles/aiplatform.user, roles/logging.logWriter, roles/cloudtrace.agent
# Not a single datastore line -- that absence is the proof of the structural guarantee
```

> On the first run the Cloud Run services do not exist yet, so the `run.invoker` grants
> emit warnings. `deploy.sh` re-runs `iam.sh` at the end to converge, so this is expected.

### 3.3 Firestore

```bash
just firestore
```

Creates the Native-mode `(default)` database in `us-central1` and sets a TTL policy on the
`expires_at` field of the `token_vault` collection.

TTL caveats:

- The TTL field must be a **timestamp**
- Enabling the policy takes **10 minutes or more**
- Actual deletion happens **within 24 hours** of expiry (not immediately)
- **Therefore the reader (Synthesis) must always validate `expires_at` itself.**
  TTL is capacity management, not access control

### 3.4 Build the images

```bash
just build                    # all four
just build gemma              # just Gemma
```

Pushes to the `agentic-fleet` repository in Artifact Registry.

The Gemma image **bakes the model in at build time**, so it is slow (15-25 minutes for
`gemma3:12b`). It runs on `e2-highcpu-32` with a 100GB disk and a 3600s timeout. To avoid
redoing this, pin the tag once a Gemma build succeeds.

### 3.5 Deploy

```bash
just deploy
```

Deploys in the order `gemma -> core -> synthesis -> gateway`, wiring each downstream URL
into the upstream service's environment (`GEMMA_BASE_URL` / `CORE_BASE_URL` /
`SYNTHESIS_BASE_URL`). This order is mandatory.

`GEMMA_BASE_URL` carries the OpenAI-compatible `/v1` path (e.g.
`https://gemma-serving-xxxx.us-central1.run.app/v1`), which is what
`packages/common/src/config.ts` validates.

Core and Synthesis are deployed in **two phases**. Their A2A Agent Card must advertise
their own public `https://` URL, and Cloud Run only assigns that once the service exists,
so the initial deploy is followed by:

```bash
gcloud run services update core-agent \
  --update-env-vars A2A_PUBLIC_URL=https://core-agent-xxxx.us-central1.run.app,A2A_HOST=core-agent-xxxx.us-central1.run.app,A2A_PROTOCOL=https
```

`just deploy` does this automatically for both services.

Exposure:

| Service           | Auth                         | Ingress      | Notes                                                |
| ----------------- | ---------------------------- | ------------ | ---------------------------------------------------- |
| `gateway-agent`   | `--allow-unauthenticated`    | all          | The only public entry point; also serves the demo UI |
| `core-agent`      | `--no-allow-unauthenticated` | all          | Gateway's ID token only                              |
| `synthesis-agent` | `--no-allow-unauthenticated` | all          | Gateway's ID token only                              |
| `gemma-serving`   | `--no-allow-unauthenticated` | **internal** | Reachable only from inside the boundary              |

Shared environment variables injected into every service:
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `VAULT_BACKEND=firestore` /
`FIRESTORE_DATABASE` / `VAULT_COLLECTION`. Core additionally gets
`GOOGLE_GENAI_USE_VERTEXAI=1` and `GEMINI_MODEL`.

#### Why Direct VPC egress is required

`gemma-serving` uses `--ingress internal`. However, Cloud Run's default egress does not
traverse a VPC, so **a Cloud Run service calling another Cloud Run service on internal
ingress gets a 403**. The fix is to give the callers (`gateway` and `synthesis`) Direct
VPC egress:

```
--network=default --subnet=default --vpc-egress=private-ranges-only
```

Because it is `private-ranges-only`, external destinations such as Vertex AI still go out
the normal path. The `default` VPC and the `us-central1` `default` subnet (10.128.0.0/20)
have been confirmed to exist in `all-thinkgs`, so nothing extra needs creating (the
requirement is `/26` or larger, and `/20` satisfies it). `compute.googleapis.com` must be
enabled for this reference to resolve (see 3.1).

Why not a Serverless VPC Access connector: the connector VM bills continuously and takes
minutes to provision. Direct VPC egress achieves the same thing with no extra resources.

---

## 4. Service-to-service auth (**implementation requirement for the code**)

Cloud Run's `--no-allow-unauthenticated` means **IAM authentication**: the caller must
attach an **ID token** as `Authorization: Bearer`, or it gets a 403. Note it must be an
ID token, not an access token (`print-access-token`).

For whoever implements the agents (this belongs in `agents/common/`):

```python
# Fetch an ID token whose audience is the target Cloud Run service URL.
# On Cloud Run this is issued via the metadata server as that service's SA.
import google.auth.transport.requests
import google.oauth2.id_token


def id_token_for(audience: str) -> str:
    req = google.auth.transport.requests.Request()
    return google.oauth2.id_token.fetch_id_token(req, audience)


def a2a_headers(target_url: str) -> dict[str, str]:
    # The audience must be the service's base URL, with no path or query string.
    # e.g. https://core-agent-xxxx.us-central1.run.app
    return {"Authorization": f"Bearer {id_token_for(target_url)}"}
```

Calls that require an ID token:

| Caller    | Callee    | Audience             |
| --------- | --------- | -------------------- |
| gateway   | core      | `CORE_BASE_URL`      |
| gateway   | synthesis | `SYNTHESIS_BASE_URL` |
| gateway   | gemma     | `GEMMA_BASE_URL`     |
| synthesis | gemma     | `GEMMA_BASE_URL`     |

Implementation notes:

- **The audience is the base URL only.** Including a path such as `/v1/chat/completions`
  results in a 403
- `OllamaLlm` calls `GEMMA_BASE_URL` (which includes `/v1`), but the `Authorization`
  header's audience must be the base URL without `/v1`
- Locally there is no metadata server, so `google-auth-library`'s `getIdTokenClient`
  falls back to the SA key in `GOOGLE_APPLICATION_CREDENTIALS`. To avoid keeping a key
  on disk, run against a local Ollama (an http endpoint gets no ID token attached)
- Tokens last about an hour. Re-fetching per hop is wasteful, so cache them with expiry
  tracking

---

## 5. Cost estimate

Rates are the real `us-central1` SKUs from the Cloud Billing API (as of 2026-08, USD).

| SKU                                | Rate                                 |
| ---------------------------------- | ------------------------------------ |
| NVIDIA L4, **no** zonal redundancy | `0.0001867` / GPU-sec = **$0.672/h** |
| NVIDIA L4, with zonal redundancy   | `0.0002909` / GPU-sec = $1.047/h     |
| Services CPU (instance-based)      | `0.000018` / vCPU-sec                |
| Services Memory (instance-based)   | `0.000002` / GiB-sec                 |

### Hourly rate while instances are up

`gemma-serving` (1 GPU + 8 vCPU + 32GiB, `--no-cpu-throttling`):

| Component                    | $/h            |
| ---------------------------- | -------------- |
| L4 GPU (no zonal redundancy) | 0.672          |
| CPU, 8 vCPU                  | 0.518          |
| Memory, 32 GiB               | 0.230          |
| **Subtotal**                 | **$1.421 / h** |

The three agent services (1 vCPU + 1GiB each): $0.072/h each, so **$0.216/h** together.

> **Total with everything warm: about $1.64 / hour**
> (About $2.01/h with zonal redundancy, roughly 23% more.)

### What it actually costs

With `--min-instances=0`, **idle costs $0**. Charges apply only while requests are being
handled and during the idle timeout (about 15 minutes by default).

| Scenario                                                  | Approx.                          |
| --------------------------------------------------------- | -------------------------------- |
| Recording the demo video (3 hours, GPU up the whole time) | **~$4.9**                        |
| Sporadic development use (about 1 hour/day)               | ~$1.6 / day                      |
| **Left running for 24h by mistake**                       | **~$39 / day** <- watch out      |
| Cloud Build (Gemma, e2-highcpu-32 for ~25 min)            | ~$0.5 / build                    |
| Firestore / Artifact Registry                             | free tier to a few tens of cents |

**Forgetting to shut down the GPU is the only real way to get hurt here.** Always run the
teardown in section 8 when you finish. Gemini (Vertex AI) is billed per token and comes to
a few tens of cents at demo scale.

---

## 6. GPU quota

A new project usually has a Cloud Run GPU quota of **0**. Check before deploying.

### Check

```sh
just quota-status
```

The recipe runs `gcloud alpha services quota list --service=run.googleapis.com`
filtered to `nvidia`, then lists the submitted quota preferences.

In the Console: **IAM & Admin -> Quotas & System Limits**, Service = _Cloud Run Admin API_,
filter for `nvidia`.

### Which quota to request

`deploy.sh` uses `--no-gpu-zonal-redundancy`, so request the **first** one:

- `Total Nvidia L4 GPU allocation without zonal redundancy, per project per region` <- **this one**
- `Total Nvidia L4 GPU allocation with zonal redundancy, per project per region`

### How to request (gcloud)

**Already submitted for `all-thinkgs`** on 2026-08-23T23:06Z. The command used:

```sh
EMAIL=you@example.com \
JUSTIFICATION="Hackathon project ... need 1x L4 in us-central1 for the demo." \
just quota-request
```

The recipe wraps `gcloud alpha quotas preferences create` with
`--quota-id=NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` and
`--preferred-value=1`, taking the region from `infra/common.sh`.

The quota id is `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` -- note it is _not_
`...PerProjectPerRegion`, which is a common and silent mistake.

Check the status:

```sh
just quota-status
```

Read the result as follows:

| Field                           | Meaning                                         |
| ------------------------------- | ----------------------------------------------- |
| `reconciling: true`             | Still under review                              |
| `quotaConfig.grantedValue: '0'` | Not granted yet -- a GPU deploy will still fail |
| `quotaConfig.grantedValue: '1'` | **Approved.** `deploy.sh` can now run           |

Current state (as of writing): preference id `34528bab-4b5b-47f1-82da-cec57b21a95d`,
`reconciling: true`, `grantedValue: 0` -- i.e. **pending**. Re-check before deploying.

### How to request (Console)

1. Select the row in the Console Quotas page -> **EDIT QUOTAS**
2. Region = `us-central1`, New limit = **1** (matching `--max-instances=1`; asking for a
   larger number draws out the review, so request the minimum you need)
3. Write the justification in English, for example:
   > Hackathon project (All Things Agentic Hackathon, submission due 2026-08-31).
   > Serving Gemma 3 with Ollama on Cloud Run GPU for a privacy-preserving
   > multi-agent gateway. Need 1x L4 in us-central1 for demo and video recording.
4. Approval takes **minutes to a few business days**. Given the deadline, **file this first,
   before anything else**

### If it is denied

| Step | Action                                                                         |
| ---- | ------------------------------------------------------------------------------ |
| 1    | Drop to `GEMMA_MODEL=gemma3:4b` (3.3GB, but still needs an L4)                 |
| 2    | Request in another region: `REGION=us-east4` / `europe-west1` / `europe-west4` |
| 3    | Give up on GPU and go through Vertex AI (below)                                |

---

## 7. Fallback when no GPU is available (Vertex AI Model Garden)

**This is a compromise, not the intended configuration.** If you use it, be sure to explain
the difference during the demo.

Instead of self-hosting Gemma, use a Vertex AI Model Garden Gemma endpoint.

```bash
# Check whether Gemma is deployable in Model Garden (read-only)
gcloud ai model-garden models list --region=us-central1 --filter="gemma" 2>/dev/null | head

# After deploying to an endpoint, delete gemma-serving and swap the env vars
gcloud run services delete gemma-serving --region=us-central1 --quiet
gcloud run services update gateway-agent --region=us-central1 \
  --set-env-vars="GEMMA_BACKEND=vertex,GEMMA_ENDPOINT_ID=<ENDPOINT_ID>"
gcloud run services update synthesis-agent --region=us-central1 \
  --set-env-vars="GEMMA_BACKEND=vertex,GEMMA_ENDPOINT_ID=<ENDPOINT_ID>"
```

This also requires adding `roles/aiplatform.user` to `sa-gateway` and `sa-synthesis`.

### The trust-boundary trade-off (important)

This project's claim is that the model touching sensitive data runs **inside a container we
operate**. Going through Model Garden changes that:

- **What is lost**: the claim that Gemma is self-hosted and raw PII never leaves our own
  containers. Raw, **pre-tokenization** text is handed to a Google-managed inference service
- **What remains**: Core (Gemini) still only ever receives masked text, and the structural
  guarantee that `sa-core` has no Firestore role is untouched. The data stays within the project
- **Net**: far better than sending raw data to an external SaaS LLM, but you can no longer
  say it is hosted inside the boundary. It is **a weaker claim** than the Cloud Run GPU setup

So the real demo should run on the GPU configuration. File the quota request in section 6
as your first action.

---

## 8. Verification

### 8.1 Deployment state

```bash
gcloud run services list --region=us-central1 \
  --format="table(metadata.name, status.url, spec.template.spec.serviceAccountName)"
```

### 8.2 Gateway (public, no auth)

```bash
GATEWAY_URL=$(gcloud run services describe gateway-agent \
  --region=us-central1 --format='value(status.url)')

curl -sS "${GATEWAY_URL}/healthz"
curl -sS "${GATEWAY_URL}/.well-known/agent.json" | jq .
```

### 8.3 Core / Synthesis (ID token required)

Use an **ID token, not an access token**.

```bash
CORE_URL=$(gcloud run services describe core-agent --region=us-central1 --format='value(status.url)')

curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${CORE_URL}/.well-known/agent.json" | jq .

# Proof that auth is actually enforced (403 is the correct answer)
curl -s -o /dev/null -w "no-auth -> HTTP %{http_code}\n" "${CORE_URL}/.well-known/agent.json"
```

> `gcloud auth print-identity-token` returns **your own** ID token. It works because you are
> an Owner. Service-to-service calls use each SA's own ID token (see section 4).

### 8.4 Gemma (internal ingress, unreachable from outside)

Being unreachable from your laptop is **correct** and is evidence the boundary works.

```bash
GEMMA_URL=$(gcloud run services describe gemma-serving --region=us-central1 --format='value(status.url)')
curl -s -o /dev/null -w "from laptop -> HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${GEMMA_URL}/api/tags"
# 403 is the expected result
```

Check connectivity through a gateway diagnostic endpoint or via the logs instead.

```bash
gcloud run services logs read gemma-serving --region=us-central1 --limit=50
```

### 8.5 Firestore TTL

```bash
gcloud firestore fields ttls list --collection-group=token_vault --database='(default)'
```

### 8.6 End to end

```bash
curl -sS -X POST "${GATEWAY_URL}/v1/query" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply to Taro Yamada (taro@example.com, 090-1234-5678) about his order."}' | jq .
```

What to check: was the text reaching Core masked, did the leak check pass, is the final
answer rehydrated, and is an OKF record attached?
(Adjust the endpoint path to match what the code owner implements.)

---

## 9. Capturing "proof of Google Cloud deployment" for the demo video

What convinces judges is imagery that makes it obvious this really runs in the cloud.
Capture the following.

### 9.1 Console (the visuals)

1. **The Cloud Run service list** - four services in `us-central1`. Make sure the URL and
   the per-service SA column are legible
2. **`gemma-serving` details -> Container(s) tab** - showing **GPU: 1 x NVIDIA L4**. This is
   the single best piece of evidence for the GPU deployment
3. **`gemma-serving` Networking tab** - Ingress control = _Internal_
4. **`core-agent` Security tab** - SA = `sa-core@...`, authentication Required
5. **Search for `sa-core` on the IAM page** - show that its roles are only `aiplatform.user`
   and friends, with **no Firestore** (this is the crux of the project)
6. **Firestore -> token_vault** - TTL enabled, documents carrying `expires_at`
7. **Cloud Trace** - a waterfall of one request making three hops: gateway -> core -> synthesis
8. **Logs Explorer** - structured logs across hops, correlated by `session_id`

### 9.2 Terminal (a few seconds each)

```bash
# The four services and their SAs
gcloud run services list --region=us-central1 \
  --format="table(metadata.name, status.url, spec.template.spec.serviceAccountName)"

# Proof the GPU is really attached
gcloud run services describe gemma-serving --region=us-central1 \
  --format="yaml(spec.template.spec.containers[0].resources, spec.template.metadata.annotations)" \
  | grep -iE 'gpu|accelerator|cpu|memory'

# Core has no Firestore access (the structural guarantee)
gcloud projects get-iam-policy all-thinkgs --flatten="bindings[].members" \
  --filter="bindings.members:sa-core@all-thinkgs.iam.gserviceaccount.com" \
  --format="value(bindings.role)"

# Auth is enforced (403) / works with an ID token (200)
curl -s -o /dev/null -w "no auth  -> %{http_code}\n" "${CORE_URL}/.well-known/agent.json"
curl -s -o /dev/null -w "with ID  -> %{http_code}\n" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${CORE_URL}/.well-known/agent.json"
```

### 9.3 Filming tips

- **Always keep the project ID `all-thinkgs` on screen** (Console header or URL bar). It is
  the simplest possible proof that this is not a local mock
- Show the public URL (`https://gateway-agent-....us-central1.run.app`) in the browser's
  address bar. A visible `localhost` ruins the effect
- **Warm the GPU up before filming.** Nobody sits through a 1-2 minute cold start on video.
  Fire one dummy request right before recording to get the instance running
- The video is 4 minutes, so keep the Console tour to 30-40 seconds and spend the rest on
  the actual behaviour (masking -> Gemini -> leak check -> rehydration)

---

## 10. Teardown

**Stopping GPU billing comes first. Always run this when you finish.**

```bash
just destroy
```

By default this deletes only the four Cloud Run services, keeping Firestore, the service
accounts, and the images. For a full cleanup:

```bash
DELETE_IMAGES=1 DELETE_SA=1 DELETE_FIRESTORE=1 just destroy
```

> `DELETE_FIRESTORE=1` destroys the Token Vault and the audit log. Do not run it while you
> still need the demo evidence.

Verify:

```bash
gcloud run services list --region=us-central1   # should be empty
```

To stop just the GPU service while keeping its configuration:

```bash
gcloud run services update gemma-serving --region=us-central1 --max-instances=0
```
