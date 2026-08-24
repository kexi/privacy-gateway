#!/usr/bin/env bash
# Enable the Google Cloud APIs required for deployment.
# `gcloud services enable` is a no-op for already-enabled APIs, so this is idempotent.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

APIS=(
  run.googleapis.com
  compute.googleapis.com  # required for Direct VPC egress (default VPC)
  artifactregistry.googleapis.com
  cloudbuild.googleapis.com
  firestore.googleapis.com
  aiplatform.googleapis.com
  iam.googleapis.com
  logging.googleapis.com
  cloudtrace.googleapis.com
)

log "enabling APIs on ${PROJECT_ID}"
gcloud services enable "${APIS[@]}" --project="${PROJECT_ID}"

# Confirm they are enabled. gcloud's filter wants "a OR b" form, so join the
# array into a parenthesised list.
FILTER="config.name=( $(printf '%s ' "${APIS[@]}") )"
log "enabled APIs:"
gcloud services list --enabled --project="${PROJECT_ID}" \
  --filter="${FILTER}" \
  --format="value(config.name)" || true
