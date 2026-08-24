#!/usr/bin/env bash
# Tear down the deployed resources. Stopping GPU billing is the top priority, so
# Cloud Run services go first.
#
# The Firestore database and the service accounts are kept by default, since
# they may collide with other uses. Set DELETE_FIRESTORE=1 / DELETE_SA=1
# explicitly for a full cleanup.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

del_service() {
  log "deleting Cloud Run service $1"
  gcloud run services delete "$1" --region="${REGION}" --project="${PROJECT_ID}" --quiet 2>/dev/null \
    || warn "service $1 not found"
}

# Delete the gateway first so the public entry point closes before anything else.
for s in "${SVC_GATEWAY}" "${SVC_SYNTHESIS}" "${SVC_CORE}" "${SVC_GEMMA}"; do
  del_service "$s"
done

if [[ "${DELETE_IMAGES:-0}" == "1" ]]; then
  log "deleting Artifact Registry repo ${AR_REPO}"
  gcloud artifacts repositories delete "${AR_REPO}" \
    --location="${REGION}" --project="${PROJECT_ID}" --quiet 2>/dev/null \
    || warn "repo ${AR_REPO} not found"
fi

if [[ "${DELETE_SA:-0}" == "1" ]]; then
  for sa in "${SA_GATEWAY}" "${SA_CORE}" "${SA_SYNTHESIS}" "${SA_GEMMA}"; do
    log "deleting service account ${sa}"
    gcloud iam service-accounts delete "$(sa_email "$sa")" \
      --project="${PROJECT_ID}" --quiet 2>/dev/null || warn "SA ${sa} not found"
  done
fi

if [[ "${DELETE_FIRESTORE:-0}" == "1" ]]; then
  warn "deleting Firestore database '${FIRESTORE_DATABASE}' - this destroys the token vault and audit log"
  gcloud firestore databases delete --database="${FIRESTORE_DATABASE}" \
    --project="${PROJECT_ID}" --quiet 2>/dev/null || warn "database not found"
fi

log "teardown done. verify no GPU service remains:"
gcloud run services list --region="${REGION}" --project="${PROJECT_ID}" \
  --format="table(metadata.name,status.url)" || true
