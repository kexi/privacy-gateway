# Google Cloud deployment recipes. Every recipe delegates to a script in infra/,
# which sources infra/common.sh for PROJECT_ID / REGION and friends. Override
# those via the environment (e.g. `PROJECT_ID=my-proj just deploy`).

# Enable the Google Cloud APIs required for deployment (idempotent)
enable-apis:
    ./infra/enable-apis.sh

# Create the service accounts and grant least-privilege IAM roles
iam:
    ./infra/iam.sh

# Create the Firestore database and apply the Token Vault TTL policy
firestore:
    ./infra/firestore.sh

# Build and push the container images with Cloud Build (optionally a subset)
build *services:
    ./infra/build.sh {{ services }}

# Deploy the Cloud Run services in dependency order (optionally a subset)
deploy *services:
    ./infra/deploy.sh {{ services }}

# Tear down the deployed resources (GPU services first, to stop billing)
destroy *args:
    ./infra/destroy.sh {{ args }}

# Run the full first-time setup: APIs, IAM, Firestore
bootstrap: enable-apis iam firestore

# Show the current Cloud Run GPU (Nvidia L4) quota for the project
quota-status:
    #!/usr/bin/env bash
    set -euo pipefail
    source ./infra/common.sh
    echo "== Effective GPU quota =="
    gcloud alpha services quota list \
      --service=run.googleapis.com \
      --consumer="projects/${PROJECT_ID}" \
      --filter="metric:nvidia" \
      --format="table(metric, quota.limit)"
    echo
    echo "== Submitted quota preferences =="
    gcloud alpha quotas preferences list --project="${PROJECT_ID}"

# Request 1x Nvidia L4 GPU quota (requires JUSTIFICATION and EMAIL env vars)
quota-request:
    #!/usr/bin/env bash
    set -euo pipefail
    source ./infra/common.sh
    : "${EMAIL:?set EMAIL to the contact address for the quota request}"
    : "${JUSTIFICATION:?set JUSTIFICATION to explain why the GPU is needed}"
    # The id is NvidiaL4GpuAllocNoZonalRedundancy...; deploy.sh passes
    # --no-gpu-zonal-redundancy, so the zonal-redundancy variant is the wrong one.
    gcloud alpha quotas preferences create \
      --service=run.googleapis.com \
      --quota-id=NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion \
      --preferred-value=1 \
      --dimensions="region=${REGION}" \
      --project="${PROJECT_ID}" \
      --email="${EMAIL}" \
      --justification="${JUSTIFICATION}"
