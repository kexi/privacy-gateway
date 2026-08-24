#!/usr/bin/env bash
# Build the four images with Cloud Build and push them to Artifact Registry.
# A subset can be given as arguments: ./build.sh gemma core
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log "ensuring Artifact Registry repo '${AR_REPO}' in ${REGION}"
run_idempotent gcloud artifacts repositories create "${AR_REPO}" \
  --repository-format=docker \
  --location="${REGION}" \
  --description="Privacy-preserving multi-agent gateway images" \
  --project="${PROJECT_ID}"

TARGETS=("$@")
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(gemma core gateway synthesis)
fi

# Map a build target to its source directory. Only gemma lives under serving/.
src_dir() {
  case "$1" in
    gemma) echo "${ROOT}/serving/gemma" ;;
    core|gateway|synthesis) echo "${ROOT}/agents/$1" ;;
    *) echo "unknown target: $1" >&2; return 1 ;;
  esac
}

for t in "${TARGETS[@]}"; do
  dir="$(src_dir "$t")"
  image="${AR_PATH}/${t}:${IMAGE_TAG}"
  if [[ ! -f "${dir}/Dockerfile" ]]; then
    warn "no Dockerfile at ${dir}, skipping '${t}'"
    continue
  fi
  log "building ${t} -> ${image}"
  if [[ "$t" == "gemma" ]]; then
    # Baking the model in needs a bigger machine and a longer timeout: pulling
    # 12b (~8.1GB) and writing the layer can take around 20 minutes.
    # An inline config is used because --tag and --build-arg cannot be combined.
    gcloud builds submit "${dir}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --config=/dev/stdin <<CFG
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '--build-arg', 'GEMMA_MODEL=${GEMMA_MODEL}', '-t', '${image}', '.']
images:
  - '${image}'
options:
  machineType: E2_HIGHCPU_32
  logging: CLOUD_LOGGING_ONLY
  diskSizeGb: 100
timeout: 3600s
CFG
  else
    # The agents share packages/common (and the gateway also builds web/), so
    # the repository root is the build context and only the Dockerfile path
    # differs.
    gcloud builds submit "${ROOT}" \
      --project="${PROJECT_ID}" \
      --region="${REGION}" \
      --config=/dev/stdin <<CFG
steps:
  - name: gcr.io/cloud-builders/docker
    args: ['build', '-f', 'agents/${t}/Dockerfile', '-t', '${image}', '.']
images:
  - '${image}'
options:
  logging: CLOUD_LOGGING_ONLY
timeout: 1800s
CFG
  fi
  log "built ${image}"
done

log "images in ${AR_PATH}:"
gcloud artifacts docker images list "${AR_PATH}" \
  --project="${PROJECT_ID}" --format="table(package,tags,createTime)" || true
