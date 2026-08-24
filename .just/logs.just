# Log and observability recipes. The narrative guide lives in
# skills/pgw-logs/LOGS.md; the raw commands live here so docs can reference
# `just <recipe>` instead of pasting gcloud invocations.
#
# PROJECT_ID / REGION mirror the Terraform defaults in
# infra/terraform/variables.tf and can be overridden via the environment.

# Freshness window used by the log-reading recipes.
log_freshness := env_var_or_default("LOG_FRESHNESS", "2h")

# Kept in sync with infra/terraform/variables.tf by hand: these recipes only
# read, so a stale value shows an empty result rather than touching the wrong
# project.
PROJECT_ID := env_var_or_default("PROJECT_ID", "all-thinkgs")
REGION := env_var_or_default("REGION", "us-central1")

# Compact one log line to the fields that matter when debugging.
[private]
_jq_fmt := '.[] | {t:.timestamp, svc:.resource.labels.service_name, sev:.severity, ev:.jsonPayload.event, msg:.jsonPayload.message, ms:.jsonPayload.duration_ms, err:.jsonPayload.error}'

# Show every log line for one request_id, across all agents
logs-request request_id:
    #!/usr/bin/env bash
    set -euo pipefail
    gcloud logging read \
      'resource.type="cloud_run_revision" jsonPayload.request_id="{{ request_id }}"' \
      --project "{{ PROJECT_ID }}" --freshness={{ log_freshness }} --order=asc --format=json \
      | jq -c '{{ _jq_fmt }}'

# Show every log line for one session_id (multiple requests, approvals)
logs-session session_id:
    #!/usr/bin/env bash
    set -euo pipefail
    gcloud logging read \
      'resource.type="cloud_run_revision" jsonPayload.session_id="{{ session_id }}"' \
      --project "{{ PROJECT_ID }}" --freshness={{ log_freshness }} --order=asc --format=json \
      | jq -c '{{ _jq_fmt }}'

# Show recent errors for one service (default: last 30 minutes)
logs-service name minutes="30":
    #!/usr/bin/env bash
    set -euo pipefail
    gcloud logging read \
      'resource.type="cloud_run_revision" resource.labels.service_name="{{ name }}" severity>=ERROR' \
      --project "{{ PROJECT_ID }}" --freshness={{ minutes }}m --order=asc --format=json \
      | jq -c '{{ _jq_fmt }}'

# Show attestation (leak check) failures
logs-attest-failures:
    #!/usr/bin/env bash
    set -euo pipefail
    gcloud logging read \
      'jsonPayload.event="attest.verdict" AND jsonPayload.verdict="fail"' \
      --project "{{ PROJECT_ID }}" --freshness={{ log_freshness }} --order=asc --format=json \
      | jq -c '.[] | {t:.timestamp, svc:.resource.labels.service_name, request_id:.jsonPayload.request_id, findings:.jsonPayload.findings}'

# Print the Cloud Trace console URL for one trace_id
trace-url trace_id:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "https://console.cloud.google.com/traces/list?project={{ PROJECT_ID }}&tid={{ trace_id }}"

# Print the Logs Explorer console URL for one request_id
logs-url request_id:
    #!/usr/bin/env bash
    set -euo pipefail
    echo "https://console.cloud.google.com/logs/query;query=jsonPayload.request_id%3D%22{{ request_id }}%22?project={{ PROJECT_ID }}"

# List the deployed Cloud Run services and their URLs
urls:
    #!/usr/bin/env bash
    set -euo pipefail
    gcloud run services list \
      --project "{{ PROJECT_ID }}" --region "{{ REGION }}" \
      --format='table(name,status.url)'

# Curl /healthz on every service with an ID token
health:
    #!/usr/bin/env bash
    set -euo pipefail
    for svc in gateway-agent core-agent synthesis-agent; do
      url=$(gcloud run services describe "$svc" \
        --project "{{ PROJECT_ID }}" --region "{{ REGION }}" \
        --format='value(status.url)' 2>/dev/null || true)
      if [ -z "$url" ]; then
        printf '%-18s not deployed\n' "$svc"
        continue
      fi
      # The ID token audience must be the callee URL, or IAM rejects the call.
      token=$(gcloud auth print-identity-token --audiences="$url")
      code=$(curl -s -o /dev/null -w '%{http_code}' -H "Authorization: Bearer ${token}" "${url}/healthz")
      printf '%-18s %s %s\n' "$svc" "$code" "$url"
    done

# Fetch one service's A2A Agent Card
agent-card service:
    #!/usr/bin/env bash
    set -euo pipefail
    url=$(gcloud run services describe "{{ service }}" \
      --project "{{ PROJECT_ID }}" --region "{{ REGION }}" \
      --format='value(status.url)')
    token=$(gcloud auth print-identity-token --audiences="$url")
    curl -s -H "Authorization: Bearer ${token}" "${url}/.well-known/agent-card.json" | jq .

# Filter a local `just dev` log file by request_id
logs-local request_id file="/tmp/pgw-dev.log":
    jq -c 'select(.request_id=="{{ request_id }}")' {{ file }}
