# Project-level foundations: API enablement, Artifact Registry and Firestore.

# The project number is what makes Cloud Run's deterministic URLs derivable, so
# it is read rather than hardcoded. See locals.tf.
data "google_project" "project" {
  project_id = var.project_id
}

# --- APIs -------------------------------------------------------------------
# Mirrors infra/enable-apis.sh. compute is required for Direct VPC egress to
# resolve the default network/subnet; the rest follow from the services below.
resource "google_project_service" "required" {
  for_each = toset([
    "compute.googleapis.com",
    "run.googleapis.com",
    "artifactregistry.googleapis.com",
    "cloudbuild.googleapis.com",
    "firestore.googleapis.com",
    "aiplatform.googleapis.com",
    "iam.googleapis.com",
    "logging.googleapis.com",
    "cloudtrace.googleapis.com",
  ])

  project = var.project_id
  service = each.value

  # Disabling an API on destroy would take unrelated workloads in the project
  # down with it, and Cloud Run cannot be re-enabled quickly enough to matter.
  disable_on_destroy         = false
  disable_dependent_services = false
}

# --- Artifact Registry ------------------------------------------------------
# Images are pushed here by Cloud Build via `just build`; the build itself stays
# outside Terraform because an image tag is an artifact, not infrastructure.
resource "google_artifact_registry_repository" "fleet" {
  project       = var.project_id
  location      = var.region
  repository_id = var.artifact_registry_repo
  format        = "DOCKER"
  description   = "Privacy-preserving multi-agent gateway images"

  depends_on = [google_project_service.required]
}

# --- Firestore --------------------------------------------------------------
# Native mode, same region as Cloud Run so vault access stays in-region.
resource "google_firestore_database" "default" {
  project     = var.project_id
  name        = var.firestore_database
  location_id = var.region
  type        = "FIRESTORE_NATIVE"

  # The Token Vault and the audit records live here. Requiring an explicit
  # `terraform state rm` (or a console deletion) before the database can go is
  # the point: `just tf-destroy` must not be able to take the demo evidence
  # with it.
  deletion_policy = "ABANDON"

  depends_on = [google_project_service.required]
}

# TTL on token_vault.expires_at: the token -> raw-value mapping disappears once
# the session is over. Not retaining the data is the strongest defence there is.
#
# Caveats that make this capacity management rather than access control, and why
# Synthesis still validates expires_at itself on every read:
#   - enabling the policy takes 10 minutes or more
#   - deletion happens within 24 hours of expiry, not at expiry
resource "google_firestore_field" "vault_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = var.vault_collection
  field      = var.vault_ttl_field

  ttl_config {}

  # Only the TTL is managed here. index_config is left empty so Terraform does
  # not fight Firestore's single-field index defaults on every plan.
  index_config {}
}

# Masked evidence records (OKF Gateway Answer, masked prompt, tokenized Core
# response) carry the same `expires_at` field as the vault so one TTL shape
# covers both collections. The application also enforces expiry on read; this
# policy is storage hygiene, not the disclosure control.
resource "google_firestore_field" "answers_ttl" {
  project    = var.project_id
  database   = google_firestore_database.default.name
  collection = var.answers_collection
  field      = var.vault_ttl_field

  ttl_config {}

  index_config {}
}
