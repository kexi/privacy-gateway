# Service accounts and least-privilege roles. Mirrors infra/iam.sh.
#
# The key design point: sa-core gets NO Firestore role at all. See below.

resource "google_service_account" "agents" {
  for_each = {
    "sa-gateway"   = "Gateway Agent (tokenize, inside trust boundary)"
    "sa-core"      = "Core Agent (Gemini reasoning, OUTSIDE vault access)"
    "sa-synthesis" = "Synthesis Agent (leak check + rehydrate)"
    "sa-gemma"     = "Gemma serving (Ollama on Cloud Run GPU)"
  }

  project      = var.project_id
  account_id   = each.key
  display_name = each.value

  depends_on = [google_project_service.required]
}

# Project-level roles, flattened to one binding per (service account, role) pair.
#
# ############################################################################
# sa-core's entry lists roles/aiplatform.user and nothing else. There is
# deliberately NO roles/datastore.user for it, and adding one would dismantle
# the central claim of this project.
#
# The Core Agent does not merely "avoid reading" the Token Vault in code -- it
# is unable to read it under IAM. That turns the trust boundary from a coding
# convention into a structural, deployable guarantee, and this absence is the
# artifact that proves it. Verify with:
#
#   gcloud projects get-iam-policy all-thinkgs --flatten="bindings[].members" \
#     --filter="bindings.members:sa-core@all-thinkgs.iam.gserviceaccount.com" \
#     --format="value(bindings.role)"
#
# Expected: aiplatform.user, logging.logWriter, cloudtrace.agent. Not one
# datastore line. Never add one.
# ############################################################################
locals {
  # Firestore: the Gateway writes vault entries, Synthesis reads them.
  # Observability: every service account writes logs and trace spans.
  sa_project_roles = {
    "sa-gateway"   = ["roles/datastore.user", "roles/logging.logWriter", "roles/cloudtrace.agent"]
    "sa-core"      = ["roles/aiplatform.user", "roles/logging.logWriter", "roles/cloudtrace.agent"]
    "sa-synthesis" = ["roles/datastore.user", "roles/logging.logWriter", "roles/cloudtrace.agent"]
    "sa-gemma"     = ["roles/logging.logWriter", "roles/cloudtrace.agent"]
  }

  sa_role_bindings = merge([
    for sa, roles in local.sa_project_roles : {
      for role in roles : "${sa}:${role}" => { sa = sa, role = role }
    }
  ]...)
}

# Why _member and not _binding: _binding is authoritative for the whole role and
# would strip bindings the project already has (including Google-managed service
# agents). _member touches only this one membership.
resource "google_project_iam_member" "agents" {
  for_each = local.sa_role_bindings

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.agents[each.value.sa].email}"
}

# --- Service-to-service invocation (A2A hops) -------------------------------
# Cloud Run's "require authentication" means IAM: the caller attaches an ID
# token whose audience is the callee's base URL, and run.invoker is what makes
# that token accepted.
resource "google_cloud_run_v2_service_iam_member" "invoker" {
  for_each = local.active_invoker_edges

  project  = var.project_id
  location = var.region
  name     = each.value.service
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.agents["sa-${each.value.caller}"].email}"

  depends_on = [
    google_cloud_run_v2_service.agents,
    google_cloud_run_v2_service.gemma,
  ]
}

# The Gateway is the only public entry point; it also serves the demo UI.
resource "google_cloud_run_v2_service_iam_member" "gateway_public" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.agents["gateway-agent"].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}
