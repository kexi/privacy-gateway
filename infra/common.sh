#!/usr/bin/env bash
# Shared configuration sourced by every infra script.
# Every value is overridable via environment variables and falls back to a
# hackathon-appropriate default.
set -euo pipefail

PROJECT_ID="${PROJECT_ID:-all-thinkgs}"

# us-central1 is the default and should stay that way. Cloud Run GPU (NVIDIA L4)
# is only available in us-central1 / us-east4 / europe-west1 / europe-west4 /
# asia-southeast1; asia-northeast1 (Tokyo) has no Cloud Run GPU, so it is not an
# option. See docs/DEPLOY.md for the full rationale.
REGION="${REGION:-us-central1}"

# Firestore location. Kept in the same region as Cloud Run to avoid
# cross-region latency and egress charges.
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-$REGION}"
FIRESTORE_DATABASE="${FIRESTORE_DATABASE:-(default)}"

# Vertex AI (Gemini) location.
VERTEX_LOCATION="${VERTEX_LOCATION:-$REGION}"
GEMINI_MODEL="${GEMINI_MODEL:-gemini-3.5-flash}"

# Artifact Registry
AR_REPO="${AR_REPO:-agentic-fleet}"
AR_HOST="${AR_HOST:-${REGION}-docker.pkg.dev}"
AR_PATH="${AR_HOST}/${PROJECT_ID}/${AR_REPO}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Cloud Run service names
SVC_GATEWAY="${SVC_GATEWAY:-gateway-agent}"
SVC_CORE="${SVC_CORE:-core-agent}"
SVC_SYNTHESIS="${SVC_SYNTHESIS:-synthesis-agent}"
SVC_GEMMA="${SVC_GEMMA:-gemma-serving}"

# Service accounts (email is ${SA}@${PROJECT_ID}.iam.gserviceaccount.com)
SA_GATEWAY="${SA_GATEWAY:-sa-gateway}"
SA_CORE="${SA_CORE:-sa-core}"
SA_SYNTHESIS="${SA_SYNTHESIS:-sa-synthesis}"
SA_GEMMA="${SA_GEMMA:-sa-gemma}"

# Gemma model. The L4 has 24GB of VRAM, so gemma3:12b (~8.1GB) is the default.
# Fall back to GEMMA_MODEL=gemma3:4b if L4 quota is unavailable.
GEMMA_MODEL="${GEMMA_MODEL:-gemma3:12b}"
GPU_TYPE="${GPU_TYPE:-nvidia-l4}"

# Token Vault collection and TTL field
VAULT_COLLECTION="${VAULT_COLLECTION:-token_vault}"
VAULT_TTL_FIELD="${VAULT_TTL_FIELD:-expires_at}"

sa_email() { echo "$1@${PROJECT_ID}.iam.gserviceaccount.com"; }

log() { printf '\033[1;34m==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }

# Idempotency helper: swallow "already exists" errors only.
# Why not a plain `gcloud ... || true`: that would hide genuine failures too, so
# we match ALREADY_EXISTS-style messages and re-raise everything else.
run_idempotent() {
  local out rc
  set +e
  out="$("$@" 2>&1)"
  rc=$?
  set -e
  if [[ $rc -ne 0 ]]; then
    if grep -qiE 'already exists|ALREADY_EXISTS|already been taken|Database already exists' <<<"$out"; then
      warn "already exists, skipping: $*"
      return 0
    fi
    echo "$out" >&2
    return $rc
  fi
  [[ -n "$out" ]] && echo "$out" >&2
  return 0
}
