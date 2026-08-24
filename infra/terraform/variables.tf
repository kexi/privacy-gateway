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
  description = "Cloud Run GPU accelerator attached to gemma-serving."
  type        = string
  default     = "nvidia-l4"
}

variable "vpc_network" {
  description = "Network used for Direct VPC egress from the agent services."
  type        = string
  default     = "default"
}

variable "vpc_subnet" {
  description = "Subnetwork used for Direct VPC egress. Must be /26 or larger; the default subnet is /20."
  type        = string
  default     = "default"
}

variable "otel_enabled" {
  description = "Whether the agents export OpenTelemetry spans to Cloud Trace."
  type        = bool
  default     = true
}
