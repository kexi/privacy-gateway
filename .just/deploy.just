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
gemma_model := env_var_or_default("GEMMA_MODEL", "gemma4:12b")

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
      targets=(gemma core gateway synthesis kill-switch)
    fi
    # Why a temp file rather than --config=/dev/stdin with an inline heredoc:
    # just re-indents recipe bodies, which would corrupt the YAML.
    cfg="$(mktemp -t cloudbuild.XXXXXX.yaml)"
    trap 'rm -f "$cfg"' EXIT
    for t in "${targets[@]}"; do
      image="${ar_path}/${t}:{{ image_tag }}"
      # `dir` is the Cloud Build context; `dockerfile` is the path within it.
      # The kill switch lives under services/ rather than agents/ because it is
      # not a member of the reasoning fleet: it never sees a prompt or a vault
      # entry, it only stops the fleet from spending money.
      case "$t" in
        gemma) dir="serving/gemma" ;;
        core|gateway|synthesis) dir="agents/${t}"; dockerfile="agents/${t}/Dockerfile" ;;
        kill-switch) dir="services/kill-switch"; dockerfile="services/kill-switch/Dockerfile" ;;
        *) echo "unknown target: $t" >&2; exit 1 ;;
      esac
      echo "==> building ${t} -> ${image}"
      if [ "$t" = "gemma" ]; then
        # Baking the model into the image needs a long timeout: pulling 12b
        # (~8.1GB) and writing the layer takes around 20 minutes. An inline
        # config is required because --tag and --build-arg cannot be combined
        # on `gcloud builds submit`. Why the default machine type: this
        # project's Cloud Build quota refuses E2_HIGHCPU_32 (verified on the
        # first deploy); the default built the image in ~13 minutes.
        printf '%s\n' \
          'steps:' \
          '  - name: gcr.io/cloud-builders/docker' \
          "    args: ['build', '--build-arg', 'GEMMA_MODEL={{ gemma_model }}', '-t', '${image}', '.']" \
          'images:' \
          "  - '${image}'" \
          'options:' \
          '  logging: CLOUD_LOGGING_ONLY' \
          '  diskSizeGb: 100' \
          'timeout: 3600s' > "$cfg"
      else
        # The agents and the kill switch share packages/common (and the gateway
        # also builds web/), so the repository root is the build context and
        # only the Dockerfile path differs.
        dir="."
        printf '%s\n' \
          'steps:' \
          '  - name: gcr.io/cloud-builders/docker' \
          "    args: ['build', '-f', '${dockerfile}', '-t', '${image}', '.']" \
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

# --- demo / filming windows --------------------------------------------------
# gemma-serving scales to zero, and a scale-from-zero costs ~90 s while Ollama
# loads gemma3:12b onto the GPU. That is fine for a smoke test (the gateway's
# REQUEST_DEADLINE_SECONDS is 150) but ruinous on camera. These two recipes pin
# an instance up for the length of a demo and then give the billing back.
#
# Why gcloud rather than Terraform: this is a temporary operational state, not
# desired state. Encoding it in Terraform would mean the repository's committed
# configuration claims a GPU should always be running, and a later `tf-apply`
# by someone else would silently re-warm it. `just chill` — or any `tf-apply`,
# which re-asserts min_instance_count = 0 — puts it back.

# Pin one gemma-serving GPU instance up so demo requests answer without a cold start
warm:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "!! An idle Cloud Run GPU instance bills continuously while warm."
    echo "!! Nvidia RTX PRO 6000 + 20 vCPU / 80 GiB in {{ region }} is roughly"
    echo "!! about USD 3.19 per hour, roughly USD 77 per day, whether or not a"
    echo "!! single request arrives."
    echo "!! Run 'just chill' the moment filming is done."
    echo
    echo "This waits for the pinned instance to report ready, which can take"
    echo "several minutes on a GPU service. Ctrl-C is safe: min-instances is"
    echo "already set, so the instance comes up regardless."
    gcloud run services update gemma-serving \
      --project "{{ project_id }}" --region "{{ region }}" \
      --min-instances=1 --quiet >/dev/null
    echo "==> gemma-serving min-instances=1; the GPU is now warm and billing."
    echo "    Send one 'just smoke' to force the model load before you record."

# Release the pinned gemma-serving instance and stop the idle GPU billing
chill:
    #!/usr/bin/env bash
    set -euo pipefail
    gcloud run services update gemma-serving \
      --project "{{ project_id }}" --region "{{ region }}" \
      --min-instances=0 --quiet >/dev/null
    echo "==> gemma-serving min-instances=0; it scales to zero and stops billing."
    echo "    The next request pays the ~90 s cold start again."

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

# --- cost kill switch --------------------------------------------------------
# An automatic stop for the one cost that can actually hurt: a gemma-serving
# instance left running. See "Automatic cost kill switch" in docs/DEPLOY.md.

# Exercise the kill-switch handler against a synthetic over-budget notification
kill-switch-test mode="local":
    #!/usr/bin/env bash
    set -euo pipefail
    # Two modes, because they prove different things.
    #
    #   local   (default) runs the vitest suite. It proves the decision logic:
    #           the >= boundary, idempotency under redelivery, and that a
    #           malformed message changes nothing. Touches no cloud resource.
    #
    #   publish sends a real message through the real topic, which means the
    #           real push subscription, the real OIDC token and the real
    #           service. It therefore REALLY TRIPS THE KILL SWITCH: the gateway
    #           loses its public invoker binding, gemma-serving is switched to
    #           manual scaling with manual_instance_count = 0, and the gateway's
    #           and synthesis's invoker rights on gemma-serving are stripped.
    #           This is state-changing and needs maintainer approval.
    #           Recover with `just restore-after-kill`.
    case "{{ mode }}" in
      local)
        pnpm --filter @privacy-gateway/kill-switch test
        ;;
      publish)
        echo "!! This publishes a REAL over-budget notification to billing-kill-switch."
        echo "!! The fleet will be taken offline. Recover with 'just restore-after-kill'."
        read -r -p "Type 'kill' to continue: " confirm
        [ "$confirm" = "kill" ] || { echo "aborted"; exit 1; }
        # Shaped like a real budget notification: the service compares
        # costAmount against budgetAmount and ignores which threshold fired.
        gcloud pubsub topics publish billing-kill-switch \
          --project="{{ project_id }}" \
          --message='{"budgetDisplayName":"agentic-fleet-kill-switch","costAmount":60,"budgetAmount":50,"currencyCode":"USD","alertThresholdExceeded":1.0}'
        echo "published; watch 'just logs-kill-switch' for killswitch.triggered"
        ;;
      *)
        echo "unknown mode: {{ mode }} (expected 'local' or 'publish')" >&2
        exit 1
        ;;
    esac

# Show what the kill switch has decided recently (triggered, under-budget, failures)
logs-kill-switch:
    gcloud logging read \
      'resource.type="cloud_run_revision" resource.labels.service_name="kill-switch"' \
      --project "{{ project_id }}" --freshness=24h --order=desc --limit=50 --format=json \
      | jq -c '.[] | {t:.timestamp, sev:.severity, ev:.jsonPayload.event, cost:.jsonPayload.cost_amount, budget:.jsonPayload.budget_amount, ratio:.jsonPayload.budget_ratio}'

# Show budget notifications that were dead-lettered after five failed deliveries
logs-kill-switch-dlq:
    #!/usr/bin/env bash
    set -euo pipefail
    # A message here means the switch could not be delivered at all — the
    # service would not start, or the platform kept answering 5xx. The handler
    # itself no longer asks for redelivery, so this queue should stay empty;
    # anything in it is the retry loop having been stopped rather than run.
    echo "== dead-lettered budget notifications =="
    gcloud pubsub subscriptions pull billing-kill-switch-dead-letter-hold \
      --project="{{ project_id }}" --limit=10 --format=json \
      | jq -r '.[] | {published: .message.publishTime, data: (.message.data | @base64d)}' \
      || echo "(none, or the dead-letter subscription is not deployed)"

# Undo a kill-switch trip: restore public access, the fleet's invoker rights and automatic scaling
restore-after-kill *vars:
    #!/usr/bin/env bash
    set -euo pipefail
    # Terraform is the restore path, not a handful of gcloud commands, because
    # Terraform already holds the desired state the switch deviated from, and it
    # holds all three pieces:
    #
    #   1. the allUsers invoker binding on gateway-agent           (iam.tf)
    #   2. the gateway/synthesis invoker bindings on gemma-serving (iam.tf,
    #      local.invoker_edges) — the switch strips these as belt and braces
    #   3. gemma-serving's service-level `scaling { scaling_mode = "AUTOMATIC" }`
    #      (cloudrun.tf) — the switch sets MANUAL with manual_instance_count = 0,
    #      which is the documented way to hold a Cloud Run service at zero
    #
    # An apply re-asserts all three and, unlike hand-written gcloud, cannot
    # restore two and forget the third. Item 3 is why cloudrun.tf declares the
    # service-level scaling block explicitly: without it Terraform would own no
    # opinion about scaling mode, see no diff, and leave the GPU pinned off.
    #
    # Deliberately not run by agents: it puts a public endpoint and a GPU back
    # online, so a human reads the plan. Review it, then approve interactively.
    echo "This re-opens the public gateway, restores the fleet's access to Gemma"
    echo "and returns gemma-serving to automatic scaling (min 0 / max 1)."
    echo "Fix the underlying spend first, or the switch will trip again."
    just tf-apply {{ vars }}

    # Clearing the marker is what re-arms the switch. It is done last and only
    # after the apply succeeded: while it is set the switch will not fire, so
    # removing it before the fleet is actually restored would leave a window in
    # which the switch is armed against a fleet that is still down.
    #
    # Why not Terraform: the annotation is runtime state written by the switch,
    # not desired state. Declaring it in Terraform would mean the committed
    # configuration has an opinion about whether the fleet is tripped.
    #
    # Why the Admin API directly rather than `gcloud run services update`: that
    # command has no `--remove-annotations` flag (it was never added; `gcloud`
    # rejects it as unrecognised). The previous version of this recipe used it
    # behind a `|| echo "(no marker was set)"`, so the failure printed a message
    # saying the opposite of what happened and left the marker in place — which
    # leaves the switch permanently disarmed, because a set marker makes every
    # subsequent trip a no-op. Read-modify-write on the v2 Service is the
    # supported way to delete one annotation. Verified live on 2026-08-30.
    echo "==> clearing the kill-switch/tripped marker"
    service_url="https://run.googleapis.com/v2/projects/{{ project_id }}/locations/{{ region }}/services/gateway-agent"
    token="$(gcloud auth print-access-token)"
    curl -fsS -H "Authorization: Bearer ${token}" "${service_url}" \
      | jq 'del(.annotations["kill-switch/tripped"])
            | del(.createTime, .updateTime, .creator, .lastModifier, .uid,
                  .generation, .latestReadyRevision, .latestCreatedRevision,
                  .observedGeneration, .terminalCondition, .conditions,
                  .trafficStatuses, .etag, .reconciling, .urls, .uri,
                  .satisfiesPzs)' \
      | curl -fsS -X PATCH -H "Authorization: Bearer ${token}" \
          -H "Content-Type: application/json" "${service_url}" -d @- >/dev/null
    echo "==> the kill switch is armed again"

    # Read back rather than trust the write: an un-cleared marker is a silently
    # disarmed switch, which is the failure mode this whole recipe exists to
    # avoid. It is the same principle the switch itself now follows.
    if curl -fsS -H "Authorization: Bearer ${token}" "${service_url}" \
         | jq -e '.annotations["kill-switch/tripped"]' >/dev/null 2>&1; then
      echo "!! the marker is STILL set: the switch will not fire again" >&2
      exit 1
    fi
    echo "    verified: no tripped marker on gateway-agent"

# Roll a new revision of already-deployed services from the latest images.
# Why not tf-apply: the image tag is `latest`, so Terraform sees no diff after
# a rebuild; Cloud Run only pulls the tag again when a new revision is forced.
roll *services:
    #!/usr/bin/env bash
    set -euo pipefail
    targets=({{ services }})
    if [ ${#targets[@]} -eq 0 ]; then
      targets=(gateway-agent core-agent synthesis-agent)
    fi
    ar_path="{{ region }}-docker.pkg.dev/{{ project_id }}/{{ ar_repo }}"
    for svc in "${targets[@]}"; do
      # Service name -> image name, stated explicitly rather than derived.
      # Why not `${svc%-agent}`: it silently produced `gemma-serving` for the
      # GPU service, whose image is `gemma`, and the roll failed with an
      # "Image not found" that reads like a missing build rather than a naming
      # bug. An explicit case cannot be wrong by omission — an unknown service
      # stops the loop instead of guessing.
      case "$svc" in
        gateway-agent) img="gateway" ;;
        core-agent) img="core" ;;
        synthesis-agent) img="synthesis" ;;
        gemma-serving) img="gemma" ;;
        kill-switch) img="kill-switch" ;;
        *) echo "unknown service: $svc" >&2; exit 1 ;;
      esac
      echo "==> rolling ${svc} from ${ar_path}/${img}:{{ image_tag }}"
      gcloud run services update "$svc" --region "{{ region }}" --project "{{ project_id }}" \
        --image "${ar_path}/${img}:{{ image_tag }}" --quiet >/dev/null
      echo "    done: $(gcloud run services describe "$svc" --region "{{ region }}" --project "{{ project_id }}" --format='value(status.latestReadyRevisionName)')"
    done
