# Derived values shared across the configuration.

locals {
  ar_path = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.fleet.repository_id}"

  # Cloud Run deterministic URL: https://SERVICE_NAME-PROJECT_NUMBER.REGION.run.app
  #
  # Verified against cloud.google.com/run/docs/triggering/https-request (2026-08):
  # Cloud Run assigns this form whenever the DNS label (service name + project
  # number + any tag) is 63 characters or fewer, and it is stable for the life of
  # the service. The longest name here is `synthesis-agent` (15) + `-` +
  # a 12-digit project number = 28 characters, comfortably inside the limit.
  # Services over the limit fall back to a hash-based SERVICE_IDENTIFIER whose
  # generation logic is explicitly "subject to change" and cannot be predicted.
  #
  # Why this matters: the shell deploy this replaced had to create each service,
  # read status.url back, and then run a second `gcloud run services update` to
  # inject A2A_PUBLIC_URL and the downstream base URLs. Computing the URL up
  # front collapses that two-phase dance into a single apply and removes the
  # dependency cycle between the services entirely.
  run_url = {
    for name in ["gateway-agent", "core-agent", "synthesis-agent", "gemma-serving"] :
    name => "https://${name}-${data.google_project.project.number}.${var.region}.run.app"
  }

  # config.ts validates GEMMA_BASE_URL as an OpenAI-compatible base, so the /v1
  # path is part of the value rather than something the client appends.
  gemma_base_url = "${local.run_url["gemma-serving"]}/v1"

  # Injected into every agent service.
  common_env = {
    GOOGLE_CLOUD_PROJECT  = var.project_id
    GOOGLE_CLOUD_LOCATION = var.region
    VAULT_BACKEND         = "firestore"
    FIRESTORE_DATABASE    = var.firestore_database
    VAULT_COLLECTION      = var.vault_collection
    ANSWER_COLLECTION     = var.answers_collection
    GEMMA_MODEL           = var.gemma_model
    OTEL_ENABLED          = var.otel_enabled ? "1" : "0"
    # Shared, not Core-only: the Gateway derives the OKF `core_actor`
    # provenance string from it (`core_agent/${GEMINI_MODEL}`). Why not scope it
    # to core-agent: the Gateway then fell back to its compiled-in default and
    # every stored OKF document named a model Core had not actually called.
    GEMINI_MODEL = var.gemini_model
  }

  # The three CPU agent services. They differ only in the fields below, so
  # for_each over this map keeps one resource block instead of three near-copies.
  agent_services = {
    "core-agent" = {
      image_dir = "core"
      # Internal ingress: Core is only ever called by the Gateway, which egresses
      # through the VPC, so nothing on the internet needs to reach it. IAM (no
      # allUsers invoker) still denies an unauthenticated caller; this stops one
      # from arriving at all.
      ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"
      # Core itself calls only Vertex AI, but its egress still goes through the
      # VPC so that Vertex AI is reached over Private Google Access rather than
      # the public internet — the reasoning that keeps Core's traffic inside
      # Google's network, matching the trust-boundary claim.
      vpc_egress = true
      env = {
        # ADK takes the Vertex AI path rather than the AI Studio one.
        # GEMINI_MODEL comes from common_env, which every agent receives.
        GOOGLE_GENAI_USE_VERTEXAI = "1"
        # gemini-3.5-flash is published only on the global Vertex endpoint;
        # the us-central1 regional endpoint 404s (probed 2026-08-28). Only the
        # GenAI SDK reads this, so overriding it here does not move Firestore
        # or anything else out of var.region.
        GOOGLE_CLOUD_LOCATION = "global"
      }
    }
    "synthesis-agent" = {
      image_dir = "synthesis"
      # Called only by the Gateway; calls internal-ingress gemma-serving. Both
      # directions therefore require the VPC path.
      ingress    = "INGRESS_TRAFFIC_INTERNAL_ONLY"
      vpc_egress = true
      env = {
        GEMMA_BASE_URL = local.gemma_base_url
        GEMMA_AUTH     = "iam"
        # Derived from the Gateway's deployed MAX_BODY_BYTES, not from the code
        # default: this body carries a whole 256 KiB-class masked prompt plus a
        # whole Core answer plus the JSON envelope, and the code's derivation
        # (input*2 + 64 KiB envelope) only sees this service's own env. Left at
        # the compile-time default, a large request paid for extraction and the
        # Core call and *then* got a 413 here. Keep in step with the Gateway's
        # MAX_BODY_BYTES below: 262144*2 + 65536.
        SYNTHESIS_MAX_BODY_BYTES = "589824"
      }
    }
    "gateway-agent" = {
      image_dir = "gateway"
      # The one public door: it serves the demo UI and /v1/ask to the internet.
      ingress    = "INGRESS_TRAFFIC_ALL"
      vpc_egress = true
      env = {
        GEMMA_AUTH = "iam"
        # 256 KiB, up from the 64 KiB code default: Codex CLI's Responses API
        # requests carry ~147 KB of instructions/tool context. Cost exposure
        # stays bounded by the per-IP rate limit, the request deadline, one GPU
        # instance and the billing kill switch.
        MAX_BODY_BYTES = "262144"
        # ~4 KB chunks: per-chunk Gemma latency falls superlinearly with size
        # (5.7 KB answered in 9 s while 12 KB took ~120 s), so many small
        # parallel chunks beat few large ones on the single GPU.
        EXTRACTION_CHUNK_BYTES = "4000"
        # All four llama.cpp slots, up from the three the code used to reserve.
        # A 147 KB Codex prompt is ~37 chunks, and at a measured 26-40 s per 4 KB
        # chunk the fan-out width is what decides whether the request beats its
        # deadline. Why not keep one slot for the Synthesis judge: the judge runs
        # after masking, not beside it, so the reserved slot was idle during the
        # only phase that could have used it.
        EXTRACTION_CONCURRENCY = "4"
        CORE_BASE_URL          = local.run_url["core-agent"]
        SYNTHESIS_BASE_URL     = local.run_url["synthesis-agent"]
        GEMMA_BASE_URL         = local.gemma_base_url
        # Why 150 and not the 60 s compiled-in default: on a cold fleet the
        # first /v1/ask blew the deadline and returned 504 before Gemma had
        # answered. The GPU instance itself starts in ~5 s; what dominates is
        # Ollama loading gemma4:12b (~8 GB) into the RTX PRO 6000 after the
        # container is up, and the request that triggers the scale-from-zero
        # waits for all of it. Measured worst case was ~90 s from cold, so 150 s
        # covers it with margin without letting a genuinely hung request hang
        # forever.
        #
        # Why not raise the default in config.ts: 60 s is the right deadline
        # once Gemma is warm, which is every request after the first. This is a
        # deployment property of a scale-to-zero GPU, not a property of the
        # gateway. Why not min-instances=1 instead: an idle GPU instance bills
        # continuously; `just warm` buys that trade deliberately for a filming
        # window, and `just chill` gives it back.
        # 240s: a warm Codex-scale extraction is ~15 chunks at 4-way
        # concurrency on one shared GPU — 150s fits only one to two waves and
        # retries never converged. 240s is the honest interactive ceiling.
        REQUEST_DEADLINE_SECONDS = "240"

        # The read-only audit view's capability token. Empty means the routes
        # are never registered, so the feature is genuinely absent rather than
        # present behind a check. Only the Gateway gets it: Core and Synthesis
        # have no audit surface to gate, and a secret is not handed to a service
        # that has no use for it.
        ADMIN_TOKEN = var.admin_token
      }
    }
  }

  # run.invoker edges: caller service account -> callee Cloud Run service.
  # Flattened into "<caller>->:<callee>" keys so a single for_each covers them.
  invoker_edges = {
    "gateway->core"      = { caller = "gateway", service = "core-agent" }
    "gateway->synthesis" = { caller = "gateway", service = "synthesis-agent" }
    "gateway->gemma"     = { caller = "gateway", service = "gemma-serving" }
    "synthesis->gemma"   = { caller = "synthesis", service = "gemma-serving" }
  }

  # Edges pointing at gemma-serving disappear along with the service when the
  # GPU quota is not yet granted.
  active_invoker_edges = {
    for key, edge in local.invoker_edges :
    key => edge
    if var.gpu_enabled || edge.service != "gemma-serving"
  }
}
