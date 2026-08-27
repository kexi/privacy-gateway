# Outputs consumed by `just urls` and the verification steps in docs/DEPLOY.md.

output "gateway_url" {
  description = "Public entry point. Also serves the demo UI."
  value       = google_cloud_run_v2_service.agents["gateway-agent"].uri
}

output "core_url" {
  description = "Core Agent (private; requires an ID token)."
  value       = google_cloud_run_v2_service.agents["core-agent"].uri
}

output "synthesis_url" {
  description = "Synthesis Agent (private; requires an ID token)."
  value       = google_cloud_run_v2_service.agents["synthesis-agent"].uri
}

output "gemma_base_url" {
  description = "OpenAI-compatible base URL for gemma-serving, including /v1. Null when gpu_enabled is false."
  value       = var.gpu_enabled ? local.gemma_base_url : null
}

# The URLs Terraform computed up front, so a mismatch against the .uri outputs
# above is immediately visible if Cloud Run ever stops issuing deterministic
# URLs for these names.
output "deterministic_urls" {
  description = "Cloud Run deterministic URLs derived from the project number."
  value       = local.run_url
}

output "kill_switch_url" {
  description = "Cost kill switch push endpoint. Null when kill_switch_enabled is false."
  value       = var.kill_switch_enabled ? google_cloud_run_v2_service.kill_switch[0].uri : null
}

output "kill_switch_topic" {
  description = "Pub/Sub topic the billing budget publishes to. Null when kill_switch_enabled is false."
  value       = var.kill_switch_enabled ? google_pubsub_topic.kill_switch[0].id : null
}

output "service_account_emails" {
  description = "Service account emails, keyed by account id."
  value       = { for id, sa in google_service_account.agents : id => sa.email }
}
