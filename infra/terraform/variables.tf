# Input variables. Every value has a hackathon-appropriate default, so a plain
# `just tf-plan` reproduces the deployment described in docs/DEPLOY.md.

variable "project_id" {
  description = "Google Cloud project that hosts the fleet."
  type        = string
  default     = "all-thinkgs"
}

variable "region" {
  description = <<-EOT
    Region for Cloud Run, Artifact Registry, Firestore and Vertex AI.

    Cloud Run GPU (NVIDIA L4) exists only in us-central1 / us-east4 /
    europe-west1 / europe-west4 / asia-southeast1. asia-northeast1 (Tokyo) has
    no Cloud Run GPU, so it is not an option. See docs/DEPLOY.md section 1.
  EOT
  type        = string
  default     = "us-central1"
}

variable "gemini_model" {
  description = "Vertex AI Gemini model the Core Agent reasons with."
  type        = string
  default     = "gemini-3.5-flash"
}

variable "gemma_model" {
  description = <<-EOT
    Ollama tag served by gemma-serving. The L4 has 24GB of VRAM, so gemma3:12b
    (~8.1GB) fits; drop to gemma3:4b if only a smaller GPU is available.

    This must match the tag baked into the image by `just build gemma`.
  EOT
  type        = string
  default     = "gemma3:12b"
}

variable "image_tag" {
  description = "Artifact Registry tag deployed to Cloud Run. `just deploy` passes the tag it just built."
  type        = string
  default     = "latest"
}

variable "gpu_enabled" {
  description = <<-EOT
    Whether to create the GPU-backed gemma-serving service.

    Set to false while the Cloud Run L4 quota request is still pending: the rest
    of the fleet then applies cleanly, and the Gemma URL the callers receive
    still points at the deterministic address the service will occupy once the
    quota is granted and this is flipped back to true.
  EOT
  type        = bool
  default     = true
}

variable "artifact_registry_repo" {
  description = "Artifact Registry repository holding the four service images."
  type        = string
  default     = "agentic-fleet"
}

variable "firestore_database" {
  description = "Firestore database id. \"(default)\" is the only database Cloud Run clients use without extra configuration."
  type        = string
  default     = "(default)"
}

variable "vault_collection" {
  description = "Firestore collection group backing the Token Vault."
  type        = string
  default     = "token_vault"
}

variable "vault_ttl_field" {
  description = "Timestamp field on vault documents that Firestore TTL expires."
  type        = string
  default     = "expires_at"
}

variable "gpu_type" {
  # Why not nvidia-l4: Google declined our L4 quota request (regional
  # exhaustion, 2026-08) and pointed at RTX PRO 6000, which also ships with
  # 1000 milliGPU auto-granted per region, so no quota wait.
  description = "Cloud Run GPU accelerator attached to gemma-serving."
  type        = string
  default     = "nvidia-rtx-pro-6000"
}

variable "vpc_network" {
  description = "Network used for Direct VPC egress from the agent services."
  type        = string
  default     = "default"
}

variable "vpc_subnet" {
  description = <<-EOT
    Subnetwork created for Direct VPC egress (infra/terraform/network.tf).

    A dedicated subnet, not the project's `default`: it must have
    private_ip_google_access enabled for internal-ingress gemma-serving to be
    reachable, and turning that on for the default subnet would be a
    project-wide side effect on a resource Terraform does not own.
  EOT
  type        = string
  default     = "agentic-fleet-us-central1"
}

variable "vpc_subnet_cidr" {
  description = <<-EOT
    IPv4 range of the Direct VPC egress subnet. Must be /26 or larger.

    Cloud Run reserves IPs in blocks of 16 and uses roughly 2x the instance
    count at steady state, so /24 leaves headroom for revision overlap during a
    deploy. Pick a range that does not collide with the default subnets.
  EOT
  type        = string
  default     = "10.60.0.0/24"
}

variable "otel_enabled" {
  description = "Whether the agents export OpenTelemetry spans to Cloud Trace."
  type        = bool
  default     = true
}

variable "answers_collection" {
  description = "Firestore collection holding masked per-request evidence (OKF documents)."
  type        = string
  default     = "gateway_answers"
}

# Whether to declare the `verify-auth` Cloud Run Job.
#
# On by default: it costs nothing at rest — a Job bills only for the seconds of
# an execution — and it is the only way to observe the IAM-success half of the
# auth boundary, since internal ingress makes that unobservable from outside the
# VPC. Set to false to keep the deployment to the four serving services.
variable "enable_verify_job" {
  description = "Declare the verify-auth Cloud Run Job used by `just verify-auth-internal`."
  type        = bool
  default     = true
}

# --- cost kill switch --------------------------------------------------------

variable "kill_switch_enabled" {
  description = <<-EOT
    Declare the automatic cost kill switch (budget, Pub/Sub topic, push
    subscription and the kill-switch Cloud Run service).

    On by default. §5 of docs/DEPLOY.md puts a forgotten GPU at roughly $39/day,
    which is the single realistic way this project loses money; an automatic
    stop is worth more than the few cents the topic and the scale-to-zero
    service cost at rest.
  EOT
  type        = bool
  default     = true
}

variable "billing_account" {
  description = <<-EOT
    Billing account the budget is created under, in `billingAccounts/XXXXXX-...`
    form.

    Creating a budget requires roles/billing.costsManager (or
    roles/billing.admin) **on the billing account**, which is a different
    resource from the project: project Owner is not sufficient. See the
    "Automatic cost kill switch" section of docs/DEPLOY.md.
  EOT
  type        = string
  default     = "billingAccounts/0136A5-03F510-FB783D"
}

variable "budget_jpy" {
  # The billing account is denominated in JPY; a budget whose currency differs
  # from the account's is rejected with 400 INVALID_ARGUMENT (observed live).
  description = "Monthly budget in JPY. Reaching 100% of it trips the kill switch."
  type        = number
  default     = 8000

  validation {
    # A zero or negative budget would be tripped by the first cent of spend, and
    # the ratio the service logs would divide by zero.
    condition     = var.budget_jpy > 0
    error_message = "budget_jpy must be greater than zero."
  }
}
