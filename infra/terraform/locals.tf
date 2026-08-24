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
    GEMMA_MODEL           = var.gemma_model
    OTEL_ENABLED          = var.otel_enabled ? "1" : "0"
  }

  # The three CPU agent services. They differ only in the fields below, so
  # for_each over this map keeps one resource block instead of three near-copies.
  agent_services = {
    "core-agent" = {
      image_dir = "core"
      # Core reaches only Vertex AI, which is a public endpoint, so it needs no
      # VPC egress. Its ingress stays open to accept the Gateway's A2A calls;
      # IAM (no allUsers invoker) is what keeps it private.
      vpc_egress = false
      env = {
        # ADK takes the Vertex AI path rather than the AI Studio one.
        GOOGLE_GENAI_USE_VERTEXAI = "1"
        GEMINI_MODEL              = var.gemini_model
      }
    }
    "synthesis-agent" = {
      image_dir = "synthesis"
      # Calls gemma-serving, which is internal-ingress, so it needs Direct VPC
      # egress for the request to be accepted.
      vpc_egress = true
      env = {
        GEMMA_BASE_URL = local.gemma_base_url
      }
    }
    "gateway-agent" = {
      image_dir  = "gateway"
      vpc_egress = true
      env = {
        CORE_BASE_URL      = local.run_url["core-agent"]
        SYNTHESIS_BASE_URL = local.run_url["synthesis-agent"]
        GEMMA_BASE_URL     = local.gemma_base_url
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
