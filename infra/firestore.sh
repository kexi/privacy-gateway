#!/usr/bin/env bash
# Create the Firestore (Native mode) database and set the Token Vault TTL policy.
#
# TTL makes the token -> raw-value mapping disappear automatically once the
# session is over. Not retaining the data is the strongest defence available, so
# this is core functionality rather than a nice-to-have.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

log "creating Firestore native database in ${FIRESTORE_LOCATION}"
if gcloud firestore databases describe --database="${FIRESTORE_DATABASE}" \
     --project="${PROJECT_ID}" >/dev/null 2>&1; then
  warn "database '${FIRESTORE_DATABASE}' already exists, skipping create"
else
  gcloud firestore databases create \
    --location="${FIRESTORE_LOCATION}" \
    --database="${FIRESTORE_DATABASE}" \
    --type=firestore-native \
    --project="${PROJECT_ID}"
fi

# TTL policy: make expires_at (a timestamp) the TTL field for the token_vault
# collection group. Enabling takes at least ~10 minutes, and actual deletion
# happens within 24 hours of expiry.
# Why not rely on TTL alone: deletion is best-effort and delayed, so the reader
# (Synthesis) must always validate expires_at itself as well.
log "enabling TTL on ${VAULT_COLLECTION}.${VAULT_TTL_FIELD}"
gcloud firestore fields ttls update "${VAULT_TTL_FIELD}" \
  --collection-group="${VAULT_COLLECTION}" \
  --database="${FIRESTORE_DATABASE}" \
  --enable-ttl \
  --project="${PROJECT_ID}" \
  --quiet

log "current TTL config:"
gcloud firestore fields ttls list \
  --collection-group="${VAULT_COLLECTION}" \
  --database="${FIRESTORE_DATABASE}" \
  --project="${PROJECT_ID}" || true
