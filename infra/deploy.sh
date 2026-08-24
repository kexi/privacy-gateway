#!/usr/bin/env bash
# Deploy the four Cloud Run services in dependency order and wire their URLs
# together via environment variables.
#
# Order: gemma -> core -> synthesis -> gateway
# Required, because each downstream URL must be known before it can be injected
# into the service upstream of it.
#
# Core and Synthesis are deployed in two phases: the initial deploy, then a
# `gcloud run services update` that injects A2A_PUBLIC_URL. The Agent Card must
# advertise the service's own public https URL, which Cloud Run only assigns
# once the service exists.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

svc_url() {
  gcloud run services describe "$1" \
    --region="${REGION}" --project="${PROJECT_ID}" \
    --format="value(status.url)"
}

# Strip the scheme and any trailing slash, leaving the bare hostname that
# A2A_HOST expects.
url_host() {
  local url="${1#*://}"
  echo "${url%%/*}"
}

# Gemma runs with --ingress internal. Cloud Run's default egress does not go
# through a VPC, so a Cloud Run -> Cloud Run internal-ingress call would be
# rejected with 403. Direct VPC egress fixes that; private-ranges-only keeps
# external destinations such as Vertex AI on the normal path.
# Why not a Serverless VPC Access connector: it bills a connector VM around the
# clock and takes minutes to provision, which is not worth it at hackathon
# scale. Direct VPC egress needs no extra resources.
VPC_NETWORK="${VPC_NETWORK:-default}"
VPC_SUBNET="${VPC_SUBNET:-default}"
VPC_EGRESS="${VPC_EGRESS:-private-ranges-only}"
VPC_FLAGS=(--network="${VPC_NETWORK}" --subnet="${VPC_SUBNET}" --vpc-egress="${VPC_EGRESS}")

COMMON_ENV="GOOGLE_CLOUD_PROJECT=${PROJECT_ID},GOOGLE_CLOUD_LOCATION=${VERTEX_LOCATION},VAULT_BACKEND=firestore,FIRESTORE_DATABASE=${FIRESTORE_DATABASE},VAULT_COLLECTION=${VAULT_COLLECTION}"

# ---------------------------------------------------------------- 1. gemma
# GPU-backed. Internal ingress keeps it inside the trust boundary, and
# authentication is required on top of that.
# --no-cpu-throttling: keep the CPU running outside requests so the model stays
#   resident.
# --no-gpu-zonal-redundancy: drops the GPU rate by roughly 36%
#   (0.0002909 -> 0.0001867 USD/GPU-sec). Unit price beats redundancy here.
# --max-instances 1: the default L4 quota is 1. Raise it after a quota increase.
log "deploying ${SVC_GEMMA} (GPU ${GPU_TYPE}, model ${GEMMA_MODEL})"
gcloud run deploy "${SVC_GEMMA}" \
  --image="${AR_PATH}/gemma:${IMAGE_TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --service-account="$(sa_email "${SA_GEMMA}")" \
  --no-allow-unauthenticated \
  --ingress=internal \
  --gpu=1 \
  --gpu-type="${GPU_TYPE}" \
  --no-gpu-zonal-redundancy \
  --no-cpu-throttling \
  --cpu=8 \
  --memory=32Gi \
  --concurrency=4 \
  --max-instances=1 \
  --min-instances=0 \
  --timeout=600 \
  --port=8080 \
  --set-env-vars="GEMMA_MODEL=${GEMMA_MODEL}" \
  --startup-probe=tcpSocket.port=8080,initialDelaySeconds=60,periodSeconds=10,failureThreshold=60,timeoutSeconds=5 \
  --quiet

# config.ts expects an OpenAI-compatible base, so the /v1 path is part of the
# value rather than something the client appends.
GEMMA_URL="$(svc_url "${SVC_GEMMA}")"
GEMMA_BASE_URL="${GEMMA_URL%/}/v1"
log "GEMMA_BASE_URL=${GEMMA_BASE_URL}"

# ----------------------------------------------------------------- 2. core
# Pure Gemini reasoning. The whole point is that it runs under a SA with no
# Firestore role. GOOGLE_GENAI_USE_VERTEXAI=1 makes ADK use the Vertex AI path.
log "deploying ${SVC_CORE} (Gemini ${GEMINI_MODEL})"
gcloud run deploy "${SVC_CORE}" \
  --image="${AR_PATH}/core:${IMAGE_TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --service-account="$(sa_email "${SA_CORE}")" \
  --no-allow-unauthenticated \
  --ingress=all \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=40 \
  --max-instances=3 \
  --timeout=300 \
  --port=8080 \
  --set-env-vars="${COMMON_ENV},GOOGLE_GENAI_USE_VERTEXAI=1,GEMINI_MODEL=${GEMINI_MODEL}" \
  --quiet

CORE_URL="$(svc_url "${SVC_CORE}")"
log "CORE_BASE_URL=${CORE_URL}"

# Phase 2 for core. A2A_PUBLIC_URL is the URL written into the Agent Card, and
# Cloud Run only assigns it once the service exists, so it cannot be part of the
# initial --set-env-vars. Why an update rather than a pre-computed URL: the
# run.app hostname includes a project-specific hash that is not derivable.
log "setting A2A_PUBLIC_URL on ${SVC_CORE}"
gcloud run services update "${SVC_CORE}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --update-env-vars="A2A_PUBLIC_URL=${CORE_URL},A2A_HOST=$(url_host "${CORE_URL}"),A2A_PROTOCOL=https" \
  --quiet

# ------------------------------------------------------------ 3. synthesis
# Leak check and rehydration. Reads the vault and calls Gemma.
log "deploying ${SVC_SYNTHESIS}"
gcloud run deploy "${SVC_SYNTHESIS}" \
  --image="${AR_PATH}/synthesis:${IMAGE_TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --service-account="$(sa_email "${SA_SYNTHESIS}")" \
  --no-allow-unauthenticated \
  --ingress=all \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=40 \
  --max-instances=3 \
  --timeout=300 \
  --port=8080 \
  "${VPC_FLAGS[@]}" \
  --set-env-vars="${COMMON_ENV},GEMMA_BASE_URL=${GEMMA_BASE_URL},GEMMA_MODEL=${GEMMA_MODEL}" \
  --quiet

SYNTHESIS_URL="$(svc_url "${SVC_SYNTHESIS}")"
log "SYNTHESIS_BASE_URL=${SYNTHESIS_URL}"

log "setting A2A_PUBLIC_URL on ${SVC_SYNTHESIS}"
gcloud run services update "${SVC_SYNTHESIS}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --update-env-vars="A2A_PUBLIC_URL=${SYNTHESIS_URL},A2A_HOST=$(url_host "${SYNTHESIS_URL}"),A2A_PROTOCOL=https" \
  --quiet

# -------------------------------------------------------------- 4. gateway
# The only public endpoint. The demo UI is served from here too.
log "deploying ${SVC_GATEWAY} (public)"
gcloud run deploy "${SVC_GATEWAY}" \
  --image="${AR_PATH}/gateway:${IMAGE_TAG}" \
  --region="${REGION}" \
  --project="${PROJECT_ID}" \
  --service-account="$(sa_email "${SA_GATEWAY}")" \
  --allow-unauthenticated \
  --ingress=all \
  --cpu=1 \
  --memory=1Gi \
  --concurrency=40 \
  --max-instances=3 \
  --timeout=300 \
  --port=8080 \
  "${VPC_FLAGS[@]}" \
  --set-env-vars="${COMMON_ENV},CORE_BASE_URL=${CORE_URL},SYNTHESIS_BASE_URL=${SYNTHESIS_URL},GEMMA_BASE_URL=${GEMMA_BASE_URL},GEMMA_MODEL=${GEMMA_MODEL}" \
  --quiet

GATEWAY_URL="$(svc_url "${SVC_GATEWAY}")"

# run.invoker can only be bound once the services exist, so converge IAM here.
log "re-applying service-level IAM bindings"
"$(dirname "${BASH_SOURCE[0]}")/iam.sh"

cat >&2 <<SUMMARY

=========================================================
 deployed (project=${PROJECT_ID} region=${REGION})
---------------------------------------------------------
 GATEWAY   (public)   ${GATEWAY_URL}
 CORE      (private)  ${CORE_URL}
 SYNTHESIS (private)  ${SYNTHESIS_URL}
 GEMMA     (internal) ${GEMMA_BASE_URL}
=========================================================
 open the demo UI:  ${GATEWAY_URL}
SUMMARY
