#!/usr/bin/env bash
# Create the four service accounts and grant least-privilege roles.
#
# The key design point: sa-core gets no Firestore role at all.
# The Core Agent (Gemini) does not merely "avoid reading" the Token Vault in
# code -- it is unable to read it under IAM. That turns the trust boundary into
# a deployable guarantee rather than a coding convention.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

create_sa() {
  local id="$1" display="$2"
  run_idempotent gcloud iam service-accounts create "$id" \
    --display-name="$display" --project="${PROJECT_ID}"
}

# Grant a project-level role. add-iam-policy-binding is idempotent for an
# existing binding.
grant_project() {
  local sa="$1" role="$2"
  log "project role ${role} -> ${sa}"
  gcloud projects add-iam-policy-binding "${PROJECT_ID}" \
    --member="serviceAccount:$(sa_email "$sa")" \
    --role="$role" \
    --condition=None \
    --quiet >/dev/null
}

# Grant run.invoker on a specific Cloud Run service. This can run before the
# services exist, so a missing service degrades to a warning instead of an error
# (deploy.sh re-runs this script once the services are up).
grant_invoker() {
  local caller_sa="$1" service="$2"
  log "run.invoker on ${service} -> ${caller_sa}"
  if ! gcloud run services add-iam-policy-binding "$service" \
      --member="serviceAccount:$(sa_email "$caller_sa")" \
      --role="roles/run.invoker" \
      --region="${REGION}" --project="${PROJECT_ID}" --quiet >/dev/null 2>&1; then
    warn "service '${service}' not found yet; re-run infra/iam.sh after infra/deploy.sh"
  fi
}

log "creating service accounts"
create_sa "${SA_GATEWAY}"   "Gateway Agent (tokenize, inside trust boundary)"
create_sa "${SA_CORE}"      "Core Agent (Gemini reasoning, OUTSIDE vault access)"
create_sa "${SA_SYNTHESIS}" "Synthesis Agent (leak check + rehydrate)"
create_sa "${SA_GEMMA}"     "Gemma serving (Ollama on Cloud Run GPU)"

# --- Firestore (Token Vault) ---
# Gateway writes, Synthesis reads. Core is deliberately absent.
grant_project "${SA_GATEWAY}"   "roles/datastore.user"
grant_project "${SA_SYNTHESIS}" "roles/datastore.user"

# --- Vertex AI (Gemini) ---
# Only Core calls Gemini, and this is the ONLY role Core gets.
grant_project "${SA_CORE}" "roles/aiplatform.user"

# --- Observability: granted to every SA ---
for sa in "${SA_GATEWAY}" "${SA_CORE}" "${SA_SYNTHESIS}" "${SA_GEMMA}"; do
  grant_project "$sa" "roles/logging.logWriter"
  grant_project "$sa" "roles/cloudtrace.agent"
done

# --- Service-to-service calls (A2A hops) ---
# Gateway -> Core / Synthesis / Gemma
grant_invoker "${SA_GATEWAY}" "${SVC_CORE}"
grant_invoker "${SA_GATEWAY}" "${SVC_SYNTHESIS}"
grant_invoker "${SA_GATEWAY}" "${SVC_GEMMA}"
# Synthesis -> Gemma (used for the leak check and consistency check)
grant_invoker "${SA_SYNTHESIS}" "${SVC_GEMMA}"

log "IAM setup done"
log "NOTE: sa-core has aiplatform.user ONLY - verify with:"
echo "  gcloud projects get-iam-policy ${PROJECT_ID} --flatten=bindings[].members \\" >&2
echo "    --filter=\"bindings.members:$(sa_email "${SA_CORE}")\" --format='value(bindings.role)'" >&2
