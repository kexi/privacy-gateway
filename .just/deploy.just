# Google Cloud deployment recipes.
#
# Infrastructure is declared in Terraform under infra/terraform/ and applied
# only through the `tf-*` recipes below. Container images are built separately
# by Cloud Build (`just build`), because an image tag is an artifact rather than
# infrastructure and rebuilding on every plan would be intolerable.
#
# Defaults live in infra/terraform/variables.tf; override them per invocation,
# e.g. `just tf-plan gpu_enabled=false`.

tf_dir := "infra/terraform"
project_id := env_var_or_default("PROJECT_ID", "all-thinkgs")
region := env_var_or_default("REGION", "us-central1")
ar_repo := env_var_or_default("AR_REPO", "agentic-fleet")
image_tag := env_var_or_default("IMAGE_TAG", "latest")
gemma_model := env_var_or_default("GEMMA_MODEL", "gemma3:12b")

# GCS bucket holding the Terraform remote state.
state_bucket := env_var_or_default("TF_STATE_BUCKET", project_id + "-tfstate")

# --- Terraform state bootstrap ----------------------------------------------

# Create the GCS bucket for Terraform remote state (idempotent; the ONLY gcloud-created resource)
tf-bootstrap:
    #!/usr/bin/env bash
    set -euo pipefail
    # Chicken-and-egg: the backend bucket must exist before `terraform init`
    # can store state in it, so it cannot be a Terraform resource itself. This
    # is the single exception to "all cloud resources live in Terraform".
    bucket="gs://{{ state_bucket }}"
    if gcloud storage buckets describe "$bucket" --project="{{ project_id }}" >/dev/null 2>&1; then
      echo "state bucket $bucket already exists"
    else
      echo "creating state bucket $bucket"
      gcloud storage buckets create "$bucket" \
        --project="{{ project_id }}" \
        --location="{{ region }}" \
        --uniform-bucket-level-access \
        --public-access-prevention
    fi
    # Versioning lets a corrupted or truncated state file be rolled back, which
    # is the difference between a bad apply and a lost deployment.
    gcloud storage buckets update "$bucket" --project="{{ project_id }}" --versioning
    echo "run 'just tf-init' next"

# --- Terraform ---------------------------------------------------------------

# Initialise Terraform against the GCS remote state backend
tf-init *args:
    cd {{ tf_dir }} && terraform init -input=false \
      -backend-config="bucket={{ state_bucket }}" {{ args }}

# Show the changes Terraform would make (pass overrides as `var=value`)
tf-plan *vars:
    #!/usr/bin/env bash
    set -euo pipefail
    args=(-input=false -var "image_tag={{ image_tag }}" -var "gemma_model={{ gemma_model }}")
    for v in {{ vars }}; do args+=(-var "$v"); done
    cd {{ tf_dir }} && terraform plan "${args[@]}"

# Apply the Terraform configuration (prompts for interactive approval)
tf-apply *vars:
    #!/usr/bin/env bash
    set -euo pipefail
    # Deliberately no -auto-approve: this creates GPU-backed billable resources,
    # so a human reads the plan every time.
    args=(-input=true -var "image_tag={{ image_tag }}" -var "gemma_model={{ gemma_model }}")
    for v in {{ vars }}; do args+=(-var "$v"); done
    cd {{ tf_dir }} && terraform apply "${args[@]}"

# Destroy the Terraform-managed resources (prompts; GPU billing stops first)
tf-destroy *vars:
    #!/usr/bin/env bash
    set -euo pipefail
    # The Firestore database has deletion_policy = ABANDON, so the Token Vault
    # and the audit records survive this. Remove it by hand if you truly mean to.
    args=(-input=true -var "image_tag={{ image_tag }}" -var "gemma_model={{ gemma_model }}")
    for v in {{ vars }}; do args+=(-var "$v"); done
    cd {{ tf_dir }} && terraform destroy "${args[@]}"

# Format the Terraform configuration in place
tf-fmt:
    cd {{ tf_dir }} && terraform fmt -recursive

# Detect Terraform formatting drift
tf-fmt-check:
    cd {{ tf_dir }} && terraform fmt -check -recursive -diff

# Validate the Terraform configuration (no cloud access, no backend)
tf-validate:
    #!/usr/bin/env bash
    set -euo pipefail
    # -backend=false so validation works in CI and pre-commit without
    # credentials for the state bucket.
    cd {{ tf_dir }}
    terraform init -backend=false -input=false >/dev/null
    terraform validate

# Lint the Terraform configuration with tflint
tf-lint:
    #!/usr/bin/env bash
    set -euo pipefail
    cd {{ tf_dir }}
    tflint --init >/dev/null
    tflint

# Show the Terraform outputs (service URLs and service account emails)
tf-output *args:
    cd {{ tf_dir }} && terraform output {{ args }}

# --- images ------------------------------------------------------------------

# Build and push the container images with Cloud Build (optionally a subset)
build *services:
    #!/usr/bin/env bash
    set -euo pipefail
    ar_path="{{ region }}-docker.pkg.dev/{{ project_id }}/{{ ar_repo }}"
    targets=({{ services }})
    if [ ${#targets[@]} -eq 0 ]; then
      targets=(gemma core gateway synthesis)
    fi
    # Why a temp file rather than --config=/dev/stdin with an inline heredoc:
    # just re-indents recipe bodies, which would corrupt the YAML.
    cfg="$(mktemp -t cloudbuild.XXXXXX.yaml)"
    trap 'rm -f "$cfg"' EXIT
    for t in "${targets[@]}"; do
      image="${ar_path}/${t}:{{ image_tag }}"
      case "$t" in
        gemma) dir="serving/gemma" ;;
        core|gateway|synthesis) dir="agents/${t}" ;;
        *) echo "unknown target: $t" >&2; exit 1 ;;
      esac
      echo "==> building ${t} -> ${image}"
      if [ "$t" = "gemma" ]; then
        # Baking the model into the image needs a bigger machine and a longer
        # timeout: pulling 12b (~8.1GB) and writing the layer takes around 20
        # minutes. An inline config is required because --tag and --build-arg
        # cannot be combined on `gcloud builds submit`.
        printf '%s\n' \
          'steps:' \
          '  - name: gcr.io/cloud-builders/docker' \
          "    args: ['build', '--build-arg', 'GEMMA_MODEL={{ gemma_model }}', '-t', '${image}', '.']" \
          'images:' \
          "  - '${image}'" \
          'options:' \
          '  machineType: E2_HIGHCPU_32' \
          '  logging: CLOUD_LOGGING_ONLY' \
          '  diskSizeGb: 100' \
          'timeout: 3600s' > "$cfg"
      else
        # The agents share packages/common (and the gateway also builds web/),
        # so the repository root is the build context and only the Dockerfile
        # path differs.
        dir="."
        printf '%s\n' \
          'steps:' \
          '  - name: gcr.io/cloud-builders/docker' \
          "    args: ['build', '-f', 'agents/${t}/Dockerfile', '-t', '${image}', '.']" \
          'images:' \
          "  - '${image}'" \
          'options:' \
          '  logging: CLOUD_LOGGING_ONLY' \
          'timeout: 1800s' > "$cfg"
      fi
      gcloud builds submit "$dir" \
        --project="{{ project_id }}" --region="{{ region }}" --config="$cfg"
      echo "==> built ${image}"
    done
    echo "images in ${ar_path}:"
    gcloud artifacts docker images list "${ar_path}" \
      --project="{{ project_id }}" --format="table(package,tags,createTime)" || true

# Build the three agent images locally, without pushing (fast packaging check)
image-build-local:
    #!/usr/bin/env bash
    set -euo pipefail
    # The repository root is the build context for all three: they share
    # packages/common, and only the Dockerfile path differs.
    for t in core gateway synthesis; do
      echo "==> building pgw-${t}:local"
      docker build -f "agents/${t}/Dockerfile" -t "pgw-${t}:local" .
    done
    echo "OK: all three images built"

# Start the Synthesis image and assert it emits real attestation digests
image-test:
    #!/usr/bin/env bash
    set -euo pipefail
    # The packaging check the unit tests structurally cannot make.
    #
    # The production image ships `dist/` alone: no `.ts` sources and no
    # `knowledge/` bundle. That is exactly the environment where the old on-disk
    # hash degraded to the literal string `unavailable` while the document still
    # wrote `verified` and read back as `machine-confirmed`. Every vitest run
    # happens in a checkout where both files are present, so no unit test could
    # ever have caught it — only starting the real container can.
    #
    # Digests are now build-time constants compiled into `dist/`, and
    # `GET /v1/attestation` reports them. A 64-hex answer from inside the
    # container is the evidence that the packaging is sound.
    image="${IMAGE:-pgw-synthesis:local}"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      echo "==> ${image} not present; building it"
      docker build -f agents/synthesis/Dockerfile -t "$image" .
    fi

    name="pgw-image-test-$$"
    trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT
    docker run -d --name "$name" -p 18083:8083 \
      -e VAULT_BACKEND=memory -e PORT=8083 "$image" >/dev/null

    # Poll rather than sleep: a fixed wait is either flaky or slow.
    for _ in $(seq 1 60); do
      if curl -sf http://127.0.0.1:18083/healthz >/dev/null 2>&1; then break; fi
      sleep 1
    done

    body=$(curl -sf http://127.0.0.1:18083/v1/attestation) || {
      echo "FAIL: could not reach /v1/attestation in the running image"
      docker logs "$name" 2>&1 | tail -40
      exit 1
    }
    echo "$body" | jq .

    for key in attester_sha256 computation_sha256; do
      value=$(echo "$body" | jq -r ".${key}")
      if ! printf '%s' "$value" | grep -Eq '^[0-9a-f]{64}$'; then
        echo "FAIL: ${key} is '${value}', not a sha256 digest"
        exit 1
      fi
      echo "OK   ${key}: ${value}"
    done

    echo "OK: the production image emits replayable attestation digests"

# Build the images and apply the Terraform configuration with that tag
deploy *vars: build (tf-apply vars)

# --- GPU quota ---------------------------------------------------------------

# Show the current Cloud Run GPU (Nvidia L4) quota for the project
quota-status:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "== Effective GPU quota =="
    gcloud alpha services quota list \
      --service=run.googleapis.com \
      --consumer="projects/{{ project_id }}" \
      --filter="metric:nvidia" \
      --format="table(metric, quota.limit)"
    echo
    echo "== Submitted quota preferences =="
    gcloud alpha quotas preferences list --project="{{ project_id }}"

# Request 1x Nvidia L4 GPU quota (requires JUSTIFICATION and EMAIL env vars)
quota-request:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${EMAIL:?set EMAIL to the contact address for the quota request}"
    : "${JUSTIFICATION:?set JUSTIFICATION to explain why the GPU is needed}"
    # The id is NvidiaL4GpuAllocNoZonalRedundancy...; the gemma-serving service
    # sets gpu_zonal_redundancy_disabled, so the zonal-redundancy variant is the
    # wrong one to request.
    gcloud alpha quotas preferences create \
      --service=run.googleapis.com \
      --quota-id=NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion \
      --preferred-value=1 \
      --dimensions="region={{ region }}" \
      --project="{{ project_id }}" \
      --email="${EMAIL}" \
      --justification="${JUSTIFICATION}"
