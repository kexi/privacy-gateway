# Deploy Runbook

Project: `all-thinkgs` (project number `257034533412`) / Region: **`us-central1`** /
Account: `kei.of.nakayama@gmail.com`

This document covers operating `infra/terraform/` and `serving/`. For the reasoning behind
the architecture see [ARCHITECTURE.md](./ARCHITECTURE.md); for the diagram see
[diagram/architecture.drawio.png](./diagram/architecture.drawio.png).

All cloud resources are declared in Terraform under `infra/terraform/` and applied through
the `just tf-*` recipes. The one exception is the GCS bucket that holds the Terraform state,
which has to exist before `terraform init` can run; `just tf-bootstrap` creates it with
gcloud. Container images are built separately by `just build`, because an image tag is an
artifact rather than infrastructure.

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

To change it, either override the environment variable (`REGION=europe-west1 just deploy`)
or pass the Terraform variable directly (`just tf-apply region=europe-west1`).

---

## 2. Prerequisites

```bash
gcloud config set project all-thinkgs
gcloud config set account kei.of.nakayama@gmail.com
gcloud auth login
gcloud auth application-default login   # Terraform and local development
```

`terraform` and `tflint` come from the Nix devShell, so `nix develop` (or direnv) is all
that is needed to get the right versions. Terraform authenticates with Application Default
Credentials, which is why the `application-default login` above is mandatory rather than
just for local development.

IAM needed by the operator: `roles/owner`, or
`run.admin` + `iam.serviceAccountAdmin` + `datastore.owner` + `artifactregistry.admin` +
`cloudbuild.builds.editor` + `serviceusage.serviceUsageAdmin` + `storage.admin`
(the last one for the Terraform state bucket).

---

## 3. Steps

Terraform is declarative and the recipes are **idempotent**. If a step fails partway, fix
the cause and re-run the same command; Terraform reconciles from whatever state exists.

The full order, including the GPU quota gate described in 3.5:

```
just tf-bootstrap                 # once per project
just tf-init                      # once per checkout
just build                        # ~25 min for Gemma (see the note in 3.3
                                  #   for the very first run on a fresh project)
just tf-plan gpu_enabled=false    # review: 33 resources to add
just tf-apply gpu_enabled=false   # everything except gemma-serving
   ... wait for the L4 quota to be granted (section 6) ...
just tf-apply                     # adds gemma-serving, 36 total
just urls && just health          # verify (section 8)
just tf-destroy                   # when finished (section 10)
```

### 3.0 Check the configuration

Defaults live in `infra/terraform/variables.tf`; `infra/terraform/example.tfvars` shows the
values worth overriding. Overrides are passed per invocation as `var=value`:

```bash
just tf-plan gemma_model=gemma3:4b
just tf-apply gpu_enabled=false
```

The environment variables `PROJECT_ID` / `REGION` / `IMAGE_TAG` / `GEMMA_MODEL` /
`TF_STATE_BUCKET` still work and are read by the recipes themselves:

```bash
GEMMA_MODEL=gemma3:4b just build gemma
```

### 3.1 Bootstrap the Terraform state bucket

```bash
just tf-bootstrap
```

Creates `gs://all-thinkgs-tfstate` (override with `TF_STATE_BUCKET`) in the deploy region
with uniform bucket-level access, public access prevention and **versioning enabled** — so a
corrupted or truncated state file can be rolled back. The recipe is idempotent and prints
`already exists` on a second run.

This is the **only** resource in the repository created by gcloud rather than Terraform.
The reason is chicken-and-egg: the backend bucket has to exist before `terraform init` can
store state in it, so it cannot be a Terraform resource itself.

### 3.2 Initialise Terraform

```bash
just tf-init
```

Runs `terraform init` against the GCS backend, passing
`-backend-config=bucket=all-thinkgs-tfstate`. The bucket name is deliberately absent from
`backend.tf`: keeping it out of the committed config lets a second environment reuse the
same directory unchanged. State is stored under the prefix `agentic-fleet`.

Re-run this after changing `TF_STATE_BUCKET`, or after a provider version bump
(`just tf-init -upgrade`).

### 3.3 Build the images

```bash
just build                    # all four
just build gemma              # just Gemma
just build core gateway       # a subset
```

Cloud Build pushes to the `agentic-fleet` repository in Artifact Registry. Images are built
outside Terraform on purpose: rebuilding on every plan would be intolerable, and the tag is
an artifact rather than infrastructure. Terraform consumes the tag through the `image_tag`
variable (default `latest`).

The Gemma image **bakes the model in at build time**, so it is slow (15-25 minutes for
`gemma3:12b`). It runs on `e2-highcpu-32` with a 100GB disk and a 3600s timeout. To avoid
redoing this, pin the tag once a Gemma build succeeds.

> The Artifact Registry repository itself is a Terraform resource, so the very first
> `just build` on a fresh project has to come **after** the first `just tf-apply`, or the
> push target does not exist yet. In practice: apply once with `gpu_enabled=false` (which
> will fail to pull images), run `just build`, then apply again. On any subsequent cycle the
> repository already exists and `just build` comes first.

### 3.4 Plan and apply

```bash
just tf-plan                  # review what would change
just tf-apply                 # apply, with interactive approval
```

`just tf-apply` deliberately does **not** pass `-auto-approve`: it creates GPU-backed
billable resources, so a human reads the plan every time. `just deploy` is the shorthand for
`just build` followed by `just tf-apply`, and takes the same `var=value` overrides.

What a clean apply creates:

| Resource type                            | `gpu_enabled=true` | `gpu_enabled=false` |
| ---------------------------------------- | ------------------ | ------------------- |
| `google_project_iam_member`              | 11                 | 11                  |
| `google_project_service`                 | 9                  | 9                   |
| `google_cloud_run_v2_service_iam_member` | 5                  | 3                   |
| `google_service_account`                 | 4                  | 4                   |
| `google_cloud_run_v2_service`            | 4                  | 3                   |
| `google_firestore_field` (TTL)           | 1                  | 1                   |
| `google_firestore_database`              | 1                  | 1                   |
| `google_artifact_registry_repository`    | 1                  | 1                   |
| **Total**                                | **36**             | **33**              |

APIs enabled by the `google_project_service` resources: `run` / `compute` /
`artifactregistry` / `cloudbuild` / `firestore` / `aiplatform` / `iam` / `logging` /
`cloudtrace`. `compute.googleapis.com` is required because Direct VPC egress references the
`default` VPC (see 3.7); without it, subnet resolution fails. They are created with
`disable_on_destroy = false`, so `just tf-destroy` leaves them enabled — disabling an API
would take unrelated workloads in the project down with it.

Firestore: a Native-mode `(default)` database in `us-central1`, plus a TTL policy on the
`expires_at` field of the `token_vault` collection.

TTL caveats:

- The TTL field must be a **timestamp**
- Enabling the policy takes **10 minutes or more**
- Actual deletion happens **within 24 hours** of expiry (not immediately)
- **Therefore the reader (Synthesis) must always validate `expires_at` itself.**
  TTL is capacity management, not access control

### 3.5 Deploying while the GPU quota is pending

`gpu_enabled=false` skips the `gemma-serving` service and the two `run.invoker` bindings
that point at it, leaving 33 resources that need no GPU quota at all. **This is the
recommended path on a fresh project**, because the L4 quota request (section 6) takes
minutes to days and everything else can be up and verified in the meantime:

```bash
just tf-plan gpu_enabled=false     # 33 to add
just tf-apply gpu_enabled=false
```

Once the quota shows `grantedValue: 1`, flip it back:

```bash
just tf-apply                      # gpu_enabled defaults to true; 3 more resources
```

The second apply adds only `gemma-serving` and its two invoker bindings. The three agent
services are **not** re-created, because the Gemma URL they were given in the first apply is
computed up front (3.6) rather than read back from the service — so it was already correct
while the service did not exist.

### 3.6 Deterministic Cloud Run URLs

Cloud Run assigns every service the URL

```
https://<service>-<project_number>.<region>.run.app
```

whenever the DNS label (service name + project number + any tag) is 63 characters or fewer.
For this project the longest is `synthesis-agent` (15) + `-` + the 12-digit project number
`257034533412` = 28 characters, comfortably inside the limit. Verified against
[cloud.google.com/run/docs/triggering/https-request](https://cloud.google.com/run/docs/triggering/https-request).

So the URLs are known before anything is created:

| Service           | URL                                                        |
| ----------------- | ---------------------------------------------------------- |
| `gateway-agent`   | `https://gateway-agent-257034533412.us-central1.run.app`   |
| `core-agent`      | `https://core-agent-257034533412.us-central1.run.app`      |
| `synthesis-agent` | `https://synthesis-agent-257034533412.us-central1.run.app` |
| `gemma-serving`   | `https://gemma-serving-257034533412.us-central1.run.app`   |

**This is why the whole fleet applies in one pass.** The shell deploy this replaced had to
create each service, read `status.url` back, and then run a second `gcloud run services
update` to inject `A2A_PUBLIC_URL` and the downstream base URLs — an ordering constraint
(`gemma -> core -> synthesis -> gateway`) plus a two-phase patch. Computing the URL from the
project number collapses that into a single apply and removes the dependency cycle between
the services entirely: Terraform creates all four in parallel.

`GEMMA_BASE_URL` carries the OpenAI-compatible `/v1` path
(`https://gemma-serving-257034533412.us-central1.run.app/v1`), which is what
`packages/common/src/config.ts` validates. `CORE_BASE_URL` and `SYNTHESIS_BASE_URL` are the
bare base URLs.

`just tf-output deterministic_urls` prints the computed values, and the `gateway_url` /
`core_url` / `synthesis_url` outputs print what Cloud Run actually assigned — a mismatch
between the two is immediately visible.

Exposure:

| Service           | Auth                          | Ingress      | Notes                                                |
| ----------------- | ----------------------------- | ------------ | ---------------------------------------------------- |
| `gateway-agent`   | `allUsers` has `run.invoker`  | all          | The only public entry point; also serves the demo UI |
| `core-agent`      | IAM (gateway SA only)         | all          | Gateway's ID token only                              |
| `synthesis-agent` | IAM (gateway SA only)         | all          | Gateway's ID token only                              |
| `gemma-serving`   | IAM (gateway / synthesis SAs) | **internal** | Reachable only from inside the boundary              |

Core and Synthesis are kept private by **IAM** — no `allUsers` invoker binding — not by
ingress. Restricting their ingress instead would only add a failure mode, since there is no
load balancer in front of them and nothing outside Cloud Run needs to reach them.
`gemma-serving` is `INGRESS_TRAFFIC_INTERNAL_ONLY` on top of IAM, which is what makes a
403 from a laptop the evidence in 8.4.

Shared environment variables injected into every agent service:
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `VAULT_BACKEND=firestore` /
`FIRESTORE_DATABASE` / `VAULT_COLLECTION` / `GEMMA_MODEL` / `OTEL_ENABLED`, plus
`A2A_PUBLIC_URL` / `A2A_HOST` / `A2A_PROTOCOL` for the service's own Agent Card. Core
additionally gets `GOOGLE_GENAI_USE_VERTEXAI=1` and `GEMINI_MODEL`.

### 3.6.1 Service accounts and IAM

The service accounts and their permissions, all declared in `infra/terraform/iam.tf`:

| SA             | Firestore             | Vertex AI         | run.invoker (granted to) | logging/trace |
| -------------- | --------------------- | ----------------- | ------------------------ | ------------- |
| `sa-gateway`   | `datastore.user`      | -                 | -                        | yes           |
| `sa-core`      | **none (deliberate)** | `aiplatform.user` | from gateway             | yes           |
| `sa-synthesis` | `datastore.user`      | -                 | from gateway             | yes           |
| `sa-gemma`     | -                     | -                 | from gateway / synthesis | yes           |

**Giving `sa-core` no Firestore role is the heart of this project.** The Core Agent being
unable to read the Token Vault is not a promise made in code; it is a fact enforced by IAM,
and now by a Terraform configuration that can be read and diffed. The command to verify it
during the demo:

```bash
gcloud projects get-iam-policy all-thinkgs \
  --flatten="bindings[].members" \
  --filter="bindings.members:sa-core@all-thinkgs.iam.gserviceaccount.com" \
  --format="value(bindings.role)"
# Expected: only roles/aiplatform.user, roles/logging.logWriter, roles/cloudtrace.agent
# Not a single datastore line -- that absence is the proof of the structural guarantee
```

The bindings use `google_project_iam_member` rather than `google_project_iam_binding`:
`_binding` is authoritative for the whole role and would strip memberships the project
already has, including Google-managed service agents.

> The old two-pass `iam.sh` warning is gone. Terraform's `depends_on` orders the
> `run.invoker` grants after the Cloud Run services within a single apply, so there is no
> first-run window where the grants fail.

### 3.7 The private network path

Three of the four services use **internal ingress**: `gemma-serving`, `core-agent` and
`synthesis-agent`. Only `gateway-agent` accepts traffic from the internet.

The subtlety that makes this work — and that a naive configuration gets wrong — is that the
callers address each other by their **public `run.app` URLs**. Cloud Run only treats such a
request as "internal" if it genuinely traversed a VPC network. Per
[Cloud Run private networking](https://cloud.google.com/run/docs/securing/private-networking),
requests between Cloud Run services "all require additional configuration before they are
recognized as 'internal'", and the documented ways to provide it are:

1. route **all** traffic from the caller through the VPC **and** enable Private Google
   Access on the subnet used by Direct VPC egress;
2. front the callee with Private Service Connect or an internal Application Load Balancer
   and reach it by internal IP;
3. enable Private Google Access and add DNS overrides mapping `run.app` to
   `private.googleapis.com` / `restricted.googleapis.com`.

This deployment implements **option 1**. In Terraform that is two settings that only work as
a pair — one on the subnet (`infra/terraform/network.tf`):

```hcl
resource "google_compute_subnetwork" "fleet" {
  name                     = "agentic-fleet-us-central1"
  ip_cidr_range            = "10.60.0.0/24"
  private_ip_google_access = true # <- without this, internal ingress is unreachable
}
```

and one on every caller (`infra/terraform/cloudrun.tf`):

```hcl
vpc_access {
  egress = "ALL_TRAFFIC" # <- not PRIVATE_RANGES_ONLY
  network_interfaces {
    network    = "default"
    subnetwork = "agentic-fleet-us-central1"
  }
}
```

> **The bug this replaces.** An earlier version used `egress = "PRIVATE_RANGES_ONLY"` against
> the `default` subnet. `PRIVATE_RANGES_ONLY` sends only RFC1918 destinations through the
> VPC, and a public `run.app` address is not an internal address — so that traffic left on
> the ordinary internet path and Cloud Run answered every Gateway → Gemma call with a `403`.
> The unit tests never caught it because they mock the Gemma endpoint.

All three agent services get this egress, `core-agent` included. Core reaches only Vertex AI,
which is a public endpoint, but routing it through the VPC means Vertex AI is reached over
Private Google Access rather than the open internet, which is what the trust-boundary claim
in `docs/ARCHITECTURE.md` actually asserts.

**Why a dedicated subnet** rather than the `default` one: Private Google Access has to be
enabled on whichever subnet Direct VPC egress attaches to, and turning it on for `default`
is a project-wide side effect on a resource Terraform does not own. Direct VPC egress also
consumes addresses from that subnet — roughly 2x the instance count, plus headroom while a
deploy's revisions overlap — so a separate `/24` means the fleet cannot exhaust addresses
other workloads depend on. (The documented minimum is `/26`; `/24` is the headroom.)

**Why not option 2** (internal ALB / Private Service Connect): both add a load balancer or a
service attachment plus forwarding rules, reserved internal IPs and private DNS zones. That
is materially more billable infrastructure and more failure modes than a four-service demo
needs, and none of it changes _who_ may invoke a service — IAM (`roles/run.invoker`, see 3.6)
already decides that. Option 1 needs one subnet.

**Why not option 3** (DNS overrides): it requires a private DNS zone rewriting `*.run.app`
for the entire network, silently changing resolution for every future workload in the
project, including ones that legitimately want the public path.

**Why not a Serverless VPC Access connector**: the connector VM bills continuously and takes
minutes to provision. Direct VPC egress achieves the same thing with no extra resources
beyond the subnet.

`compute.googleapis.com` must be enabled for the network reference to resolve (see 3.4).
No Cloud NAT is required: Private Google Access keeps Google-API traffic on Google's internal
network rather than pushing it out through a NAT.

Verify the path end to end with `just smoke` — it is the only check that actually crosses it.

### 3.8 Keeping the configuration honest

`terraform fmt`, `terraform validate` and `tflint` run in the lefthook pre-commit hook
(scoped to `infra/terraform/*.tf`) and in a dedicated `terraform` job in CI. Locally:

```bash
just tf-fmt          # format in place
just tf-fmt-check    # detect drift
just tf-validate     # validate without a backend or credentials
just tf-lint         # tflint
```

`just tf-validate` and the CI job both use `-backend=false`, so they work without
credentials for the state bucket. All four are also reachable through the aggregate
`just fmt` / `just fmt-check` / `just lint` / `just check` entry points.

---

## 4. Service-to-service auth (**implementation requirement for the code**)

Cloud Run "require authentication" means **IAM authentication**: the caller must attach an
**ID token** as `Authorization: Bearer`, or it gets a 403. Note it must be an ID token, not
an access token (`print-access-token`). `roles/run.invoker` on the callee is what makes that
token accepted, and those bindings are the
`google_cloud_run_v2_service_iam_member.invoker` resources in `infra/terraform/iam.tf`.

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
    # e.g. https://core-agent-257034533412.us-central1.run.app
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

`gemma-serving` (1 GPU + 8 vCPU + 32GiB, `cpu_idle = false`):

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

With `min_instance_count = 0`, **idle costs $0**. Charges apply only while requests are being
handled and during the idle timeout (about 15 minutes by default).
An apply with `gpu_enabled=false` costs essentially nothing while the quota is pending, which
is another reason to prefer that path.

| Scenario                                                  | Approx.                          |
| --------------------------------------------------------- | -------------------------------- |
| Recording the demo video (3 hours, GPU up the whole time) | **~$4.9**                        |
| Sporadic development use (about 1 hour/day)               | ~$1.6 / day                      |
| **Left running for 24h by mistake**                       | **~$39 / day** <- watch out      |
| Cloud Build (Gemma, e2-highcpu-32 for ~25 min)            | ~$0.5 / build                    |
| Firestore / Artifact Registry / state bucket              | free tier to a few tens of cents |

**Forgetting to shut down the GPU is the only real way to get hurt here.** Always run the
teardown in section 10 when you finish. Gemini (Vertex AI) is billed per token and comes to
a few tens of cents at demo scale.

---

## 6. GPU quota

A new project usually has a Cloud Run GPU quota of **0**. Check before deploying with
`gpu_enabled=true`.

### Check

```sh
just quota-status
```

The recipe runs `gcloud alpha services quota list --service=run.googleapis.com`
filtered to `nvidia`, then lists the submitted quota preferences.

In the Console: **IAM & Admin -> Quotas & System Limits**, Service = _Cloud Run Admin API_,
filter for `nvidia`.

### Which quota to request

`gemma-serving` sets `gpu_zonal_redundancy_disabled = true`, so request the **first** one:

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
`--quota-id=NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` and `--preferred-value=1`,
taking the region from the `REGION` environment variable (default `us-central1`).

The quota id is `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` -- note it is _not_
`...PerProjectPerRegion`, which is a common and silent mistake.

Check the status:

```sh
just quota-status
```

Read the result as follows:

| Field                           | Meaning                                            |
| ------------------------------- | -------------------------------------------------- |
| `reconciling: true`             | Still under review                                 |
| `quotaConfig.grantedValue: '0'` | Not granted yet -- deploy with `gpu_enabled=false` |
| `quotaConfig.grantedValue: '1'` | **Approved.** `just tf-apply` can now run          |

Current state (as of writing): preference id `34528bab-4b5b-47f1-82da-cec57b21a95d`,
`reconciling: true`, `grantedValue: 0` -- i.e. **pending**. Re-check before deploying.

### How to request (Console)

1. Select the row in the Console Quotas page -> **EDIT QUOTAS**
2. Region = `us-central1`, New limit = **1** (matching `max_instance_count = 1`; asking for
   a larger number draws out the review, so request the minimum you need)
3. Write the justification in English, for example:
   > Hackathon project (All Things Agentic Hackathon, submission due 2026-08-31).
   > Serving Gemma 3 with Ollama on Cloud Run GPU for a privacy-preserving
   > multi-agent gateway. Need 1x L4 in us-central1 for demo and video recording.
4. Approval takes **minutes to a few business days**. Given the deadline, **file this first,
   before anything else**

### While it is pending, or if it is denied

| Step | Action                                                                                       |
| ---- | -------------------------------------------------------------------------------------------- |
| 0    | **Deploy the other 33 resources now**: `just tf-apply gpu_enabled=false` (see 3.5)           |
| 1    | Drop to `just tf-apply gemma_model=gemma3:4b` (3.3GB, but still needs an L4)                 |
| 2    | Request in another region: `just tf-apply region=us-east4` / `europe-west1` / `europe-west4` |
| 3    | Give up on GPU and go through Vertex AI (below)                                              |

---

## 7. Fallback when no GPU is available (Vertex AI Model Garden)

**This is a compromise, not the intended configuration.** If you use it, be sure to explain
the difference during the demo.

Instead of self-hosting Gemma, use a Vertex AI Model Garden Gemma endpoint.

```bash
# Check whether Gemma is deployable in Model Garden (read-only)
gcloud ai model-garden models list --region=us-central1 --filter="gemma" 2>/dev/null | head
```

Then take `gemma-serving` out of the picture and point the agents at the endpoint:

```bash
just tf-apply gpu_enabled=false
```

The Terraform configuration has no Model Garden variables, so wiring `GEMMA_BACKEND=vertex`
and `GEMMA_ENDPOINT_ID` into `gateway-agent` and `synthesis-agent` means adding them to
`local.agent_services` in `infra/terraform/locals.tf` and re-applying — not a
`gcloud run services update`, which the next apply would revert. The same edit needs
`roles/aiplatform.user` added to `sa-gateway` and `sa-synthesis` in
`local.sa_project_roles` (`infra/terraform/iam.tf`).

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
as your first action, and use `gpu_enabled=false` to keep building while it is reviewed.

---

## 8. Verification

### 8.1 Deployment state

```bash
just urls      # the deployed services and their URLs
just health    # /healthz on each agent, with an ID token
just tf-output # the Terraform outputs, including deterministic_urls
```

`just health` prints `not deployed` for a service that does not exist, which is the expected
line for `gemma-serving` while the quota is pending.

### 8.2 Gateway (public, no auth)

```bash
GATEWAY_URL=$(gcloud run services describe gateway-agent \
  --region=us-central1 --format='value(status.url)')

curl -sS "${GATEWAY_URL}/healthz"
curl -sS "${GATEWAY_URL}/.well-known/agent-card.json" | jq .
```

### 8.3 Core / Synthesis (ID token required)

Use an **ID token, not an access token**.

```bash
just verify-auth
```

That recipe is **half** the check, and it is the half a laptop can perform: for each
private service it calls `/healthz` twice, once anonymously and once with an ID token, and
asserts `403` both times. Since `core-agent`, `synthesis-agent` and `gemma-serving` all use
**internal ingress**, and ingress is evaluated before IAM, a request from outside the VPC is
refused at the network edge whether or not it carries a valid token. A `200` here would mean
the ingress setting had regressed. Run by hand it is:

```bash
CORE_URL=$(gcloud run services describe core-agent --region=us-central1 --format='value(status.url)')

# The audience must be the callee URL. A token minted for anything else is rejected
# even when you are an Owner.
curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token --audiences="${CORE_URL}")" \
  "${CORE_URL}/.well-known/agent-card.json" | jq .

# Proof that auth is actually enforced (403 is the correct answer)
curl -s -o /dev/null -w "no-auth -> HTTP %{http_code}\n" "${CORE_URL}/.well-known/agent-card.json"
```

> `gcloud auth print-identity-token` returns **your own** ID token. It works because you are
> an Owner. Service-to-service calls use each SA's own ID token (see section 4).

`just agent-card core-agent` does the token dance for you.

### Verifying IAM from inside the VPC

The other half of the proof — that IAM **accepts** an authorized caller — cannot be observed
from a laptop at all, for the reason above. It has to run inside the VPC:

```bash
just verify-auth-internal
```

That executes a Cloud Run **Job** (`infra/terraform/verify_job.tf`) which attaches to the
fleet subnet with Direct VPC egress and runs as the Gateway's own service account. It calls
`/healthz` on each private service twice — once with an ID token minted from the metadata
server for the callee's origin, once anonymously — and asserts `200` then `403`. That is the
exact hop the Gateway makes in production, made by the same identity, so a `200` is evidence
about the fleet rather than about a broader credential. A Job costs nothing at rest; it bills
only for the seconds of one execution.

Read its output with `just logs-service verify-auth 30`.

**If the job is not deployed** (`enable_verify_job = false`, or Terraform has not been
applied), the manual path is:

1. Deploy the job: `just tf-apply` with `enable_verify_job=true` (the default).
2. Or, without Terraform, run the same probe from any workload already inside the VPC —
   `gcloud run jobs execute` on an ad-hoc job, or a shell on a GCE instance in the fleet
   subnet — fetching the token from the metadata server:

   ```bash
   CORE_URL=$(gcloud run services describe core-agent --region=us-central1 --format='value(status.url)')
   TOKEN=$(curl -sf -H 'Metadata-Flavor: Google' \
     "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${CORE_URL}")
   curl -s -o /dev/null -w 'with-id-token -> HTTP %{http_code}\n' \
     -H "Authorization: Bearer ${TOKEN}" "${CORE_URL}/healthz"   # expect 200
   curl -s -o /dev/null -w 'no-auth       -> HTTP %{http_code}\n' "${CORE_URL}/healthz"  # expect 403
   ```

`just smoke` exercises the same path implicitly, end to end, but it cannot isolate the IAM
decision the way the job above does.

### 8.3b Attestation digests inside the production image

The Synthesis image ships `dist/` alone — no `.ts` sources and no `knowledge/` bundle — so a
digest computed by hashing a file at runtime would be unavailable there. The digests are
compiled in at build time instead, and `just image-test` proves it by starting the real image
and reading `GET /v1/attestation`:

```bash
just image-test
```

Both `attester_sha256` and `computation_sha256` must be 64 lowercase hex characters. A
document that cannot name usable digests is emitted as `status: draft` with no `verified`
entry, so it can never read back as machine-confirmed.

### 8.4 Gemma (internal ingress, unreachable from outside)

Being unreachable from your laptop is **correct** and is evidence the boundary works.

```bash
GEMMA_URL=$(gcloud run services describe gemma-serving --region=us-central1 --format='value(status.url)')
curl -s -o /dev/null -w "from laptop -> HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${GEMMA_URL}/api/tags"
# 403 is the expected result
```

Check connectivity through a gateway diagnostic endpoint or via the logs instead
(`just logs-service gemma-serving`).

### 8.5 Firestore TTL

```bash
gcloud firestore fields ttls list --collection-group=token_vault --database='(default)'
```

### 8.6 End to end

```bash
just smoke
```

`just smoke` posts a fixed PII sample to `/v1/ask` on the deployed Gateway and asserts that
the response is `200`, that the masked prompt contains `⟦TYPE_N⟧` placeholders, and that the
raw email and phone number do **not** appear in it. It is the deployed counterpart of the
mocked unit tests: it is the only check that exercises Cloud Run IAM, the VPC path to Gemma
and the Firestore vault together.

By hand:

```bash
curl -sS -X POST "${GATEWAY_URL}/v1/ask" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Reply to Taro Yamada (taro@example.com, 090-1234-5678) about his order."}' | jq .
```

What to check: was the text reaching Core masked, did the leak check pass, is the final
answer rehydrated, and is an OKF record attached?

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
8. **Logs Explorer** - structured logs across hops, correlated by `request_id` (there is no
   `session_id`: the Gateway mints one UUIDv7 per request and uses it as the vault key)

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

# Auth is enforced (403) / works with an ID token (200), for every private service
just verify-auth

# One real request through the deployed fleet, with the privacy assertions
just smoke
```

Worth adding now that the infrastructure is declarative: a few seconds of
`infra/terraform/iam.tf` on screen, scrolled to the block that gives `sa-core` only
`roles/aiplatform.user`. The absence of a Firestore role is easier to believe when it is
visible as committed code next to the `gcloud` output that confirms it.

### 9.3 Filming tips

- **Always keep the project ID `all-thinkgs` on screen** (Console header or URL bar). It is
  the simplest possible proof that this is not a local mock
- Show the public URL (`https://gateway-agent-257034533412.us-central1.run.app`) in the
  browser's address bar. A visible `localhost` ruins the effect
- **Warm the GPU up before filming.** Nobody sits through a 1-2 minute cold start on video.
  Fire one dummy request right before recording to get the instance running
- The video is 4 minutes, so keep the Console tour to 30-40 seconds and spend the rest on
  the actual behaviour (masking -> Gemini -> leak check -> rehydration)

---

## 10. Teardown

**Stopping GPU billing comes first. Always run this when you finish.**

```bash
just tf-destroy
```

Terraform prompts for confirmation and then removes everything it manages: the four Cloud
Run services, the four service accounts and their role bindings, the invoker bindings and
the Artifact Registry repository (images included).

Two things deliberately survive:

| Resource              | Why it survives                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| Firestore `(default)` | `deletion_policy = ABANDON` — the Token Vault and the audit records stay |
| The 9 enabled APIs    | `disable_on_destroy = false` — disabling them would hit other workloads  |

The Firestore database is abandoned rather than destroyed on purpose: `just tf-destroy` must
not be able to take the demo evidence with it. If you genuinely mean to delete it, do so by
hand in the Console after removing it from state. (The old `DELETE_FIRESTORE=1` /
`DELETE_SA=1` / `DELETE_IMAGES=1` flags on `just destroy` no longer exist; service accounts
and images now go with the normal destroy.)

The Terraform state bucket is outside Terraform's own lifecycle, so `just tf-destroy` leaves
it in place. That is what makes a later `just tf-apply` a clean re-create rather than a
re-bootstrap.

Verify:

```bash
just urls        # should be empty
just tf-output   # should report no outputs
```

To stop just the GPU service while keeping everything else deployed:

```bash
just tf-apply gpu_enabled=false
```

This is the same switch used while the quota is pending, and it is the preferred way to park
the fleet between sessions: GPU billing stops, the other 33 resources stay up, and
`just tf-apply` brings Gemma back without touching the agent services.
