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

# Show every refused release, optionally narrowed to one refusal reason
logs-refusals reason="":
    #!/usr/bin/env bash
    set -euo pipefail
    # Refusals are the fleet working, not failing, so they get their own view:
    # `refusal` names which gate stopped the request.
    query='resource.type="cloud_run_revision" (jsonPayload.event="request.refused" OR jsonPayload.event="release.refused")'
    if [ -n "{{ reason }}" ]; then
      query="$query jsonPayload.refusal=\"{{ reason }}\""
    fi
    gcloud logging read "$query" \
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

# Prove the private services are unreachable from outside the VPC (run from a laptop)
verify-auth:
    #!/usr/bin/env bash
    set -euo pipefail
    # What this half of the check can honestly prove, and no more.
    #
    # core-agent, synthesis-agent and gemma-serving all use **internal ingress**.
    # Ingress is evaluated before IAM, so a request from a laptop is refused at
    # the network edge whether or not it carries a valid ID token — 403 both
    # ways is the correct result, and a 200 here would mean the ingress setting
    # had regressed. Expecting 200 with a token (as this recipe used to) was
    # asking for evidence the architecture makes impossible.
    #
    # The other half — an authenticated call actually succeeding — can only be
    # observed from inside the VPC. Run `just verify-auth-internal` for that.
    #
    # /healthz is probed rather than the Agent Card because every service has it,
    # including gemma-serving, which speaks no A2A.
    fail=0
    for svc in core-agent synthesis-agent gemma-serving; do
      url=$(gcloud run services describe "$svc" \
        --project "{{ PROJECT_ID }}" --region "{{ REGION }}" \
        --format='value(status.url)' 2>/dev/null || true)
      if [ -z "$url" ]; then
        printf '%-18s not deployed (skipped)\n' "$svc"
        continue
      fi

      anon=$(curl -s -o /dev/null -w '%{http_code}' "${url}/healthz" || true)

      # The audience must be the callee URL; a token minted for anything else is
      # rejected even when the caller is an Owner. It is still refused here,
      # because internal ingress stops the request before IAM sees the token.
      token=$(gcloud auth print-identity-token --audiences="$url")
      authed=$(curl -s -o /dev/null -w '%{http_code}' \
        -H "Authorization: Bearer ${token}" "${url}/healthz" || true)

      expected="403/403 (internal ingress: unreachable from a laptop, as designed)"
      [ "$anon" = "403" ] && [ "$authed" = "403" ] || fail=1
      printf '%-18s no-auth=%s with-id-token=%s  expected %s\n' "$svc" "$anon" "$authed" "$expected"
    done

    url=$(gcloud run services describe gateway-agent \
      --project "{{ PROJECT_ID }}" --region "{{ REGION }}" \
      --format='value(status.url)' 2>/dev/null || true)
    if [ -n "$url" ]; then
      anon=$(curl -s -o /dev/null -w '%{http_code}' "${url}/healthz" || true)
      # The Gateway is the one public door; an anonymous 200 here is correct.
      printf '%-18s no-auth=%s              expected 200 (public entry point)\n' "gateway-agent" "$anon"
      [ "$anon" = "200" ] || fail=1
    fi

    [ "$fail" -eq 0 ] \
      && echo "OK: private services refuse every caller from outside the VPC; run 'just verify-auth-internal' for the IAM-success half" \
      || { echo "FAIL: see above"; exit 1; }

# Prove IAM *accepts* an authorized caller, from inside the VPC (Cloud Run Job)
verify-auth-internal:
    #!/usr/bin/env bash
    set -euo pipefail
    # The complement to `verify-auth`. A 403 from a laptop only proves the door
    # is shut; this proves it opens for the right identity.
    #
    # It has to run inside the VPC, because the private services use internal
    # ingress: a caller on the public internet is refused at the network edge
    # before IAM is consulted, so no laptop-side test can ever observe the
    # success case. The job below runs on the same Direct VPC egress path the
    # Gateway uses, with the Gateway's own service account, so a 200 here is the
    # exact hop the fleet makes in production.
    #
    # Terraform declares the job (`infra/terraform/verify_job.tf`); this recipe
    # only executes it. If it is not deployed, the manual path is documented in
    # docs/DEPLOY.md §"Verifying IAM from inside the VPC".
    if ! gcloud run jobs describe verify-auth \
      --project "{{ PROJECT_ID }}" --region "{{ REGION }}" >/dev/null 2>&1; then
      echo "verify-auth job is not deployed."
      echo "Apply infra/terraform (just tf-apply), or follow the manual path in docs/DEPLOY.md."
      exit 1
    fi

    gcloud run jobs execute verify-auth \
      --project "{{ PROJECT_ID }}" --region "{{ REGION }}" --wait

    echo "Job finished. Read its output with:"
    echo "  just logs-service verify-auth 30"

# Check the Codex wire contract against the deployed fleet with a small payload (routine)
#
# The Codex surface check to run day to day. It speaks the Responses API directly
# rather than launching the CLI, so it verifies the protocol — SSE event
# sequence, masking, rehydration — without the CLI's ~147 KB instruction block,
# whose masking cost on a single GPU is a capacity property, not a protocol one.
# The full CLI path is `just codex-e2e`, kept for the final pre-submission check.
codex-smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    # Why a nonce: the scenario asserts a per-run token round-trips, so a cached
    # or hallucinated answer cannot pass it.
    #
    # Why letters rather than the obvious timestamp-and-$RANDOM: a long run of
    # digits is what a card number looks like, so the numeric form was detected
    # as CREDIT_CARD, masked, and — since CREDIT_CARD is a withheld category —
    # never rehydrated. The fleet was behaving exactly as designed; the test was
    # feeding it a nonce indistinguishable from the PII it exists to catch.
    export PGW_NONCE="PGW$(LC_ALL=C tr -dc 'A-Z' </dev/urandom | head -c 10)"
    # Resolved from the deployment rather than hard-coded, so this cannot quietly
    # keep testing a service that has been replaced.
    PGW_BASE_URL="${PGW_BASE_URL:-$(gcloud run services describe gateway-agent \
      --project "{{ PROJECT_ID }}" --region "{{ REGION }}" \
      --format='value(status.url)')}"
    export PGW_BASE_URL
    echo "gateway: ${PGW_BASE_URL}"
    # Rendered first so the `expect` carries the literal nonce: pitty does not
    # expand variables inside an assertion. See .just/render-scenario.sh.
    render_dir=$(mktemp -d)
    trap 'rm -rf "$render_dir"' EXIT
    rendered=$(./.just/render-scenario.sh tests/codex/pgw-responses.yaml "$render_dir")
    nix run github:kexi/pitty/v1.2.2 -- run "$rendered"

# Smoke-test the deployed Gateway end to end with a fixed PII sample
smoke:
    #!/usr/bin/env bash
    set -euo pipefail
    # Runs against the real deployment, so it exercises Cloud Run IAM, the VPC
    # path to Gemma and the Firestore vault — none of which the mocked unit
    # tests touch. This is the check that the submission gate's statement 1
    # ("a public /v1/ask reaches real Gemma, Gemini and Synthesis") is true.
    url=$(gcloud run services describe gateway-agent \
      --project "{{ PROJECT_ID }}" --region "{{ REGION }}" \
      --format='value(status.url)')

    # Fixed sample so the expected placeholders are deterministic. The values are
    # obviously synthetic; see .gitleaks.toml for the allow-list entry.
    # /v1/ask accepts `{"text": ...}` and nothing else: the request schema is
    # `strict()`, so a stray `prompt` or `session_id` is a 400, not a warning.
    body='{"text":"Reply to Taro Yamada (taro@example.com, 090-1234-5678) about his order."}'

    response=$(mktemp)
    trap 'rm -f "$response"' EXIT
    code=$(curl -sS -o "$response" -w '%{http_code}' \
      -X POST "${url}/v1/ask" \
      -H 'Content-Type: application/json' \
      -d "$body")

    echo "POST ${url}/v1/ask -> HTTP ${code}"
    jq . < "$response" || cat "$response"

    [ "$code" = "200" ] || { echo "FAIL: expected HTTP 200"; exit 1; }

    # The masked prompt Core saw must carry ⟦TYPE_N⟧ placeholders, never the raw
    # values. Their presence is the privacy guarantee being observable from
    # outside the boundary.
    jq -e '(.masked_prompt // "") | test("⟦[A-Z_]+_[0-9]+⟧")' < "$response" >/dev/null \
      || { echo "FAIL: no ⟦TYPE_N⟧ placeholder found in masked_prompt"; exit 1; }

    # And the raw PII must not appear in the masked prompt at all.
    jq -e '(.masked_prompt // "") | test("taro@example.com|090-1234-5678") | not' < "$response" >/dev/null \
      || { echo "FAIL: raw PII survived into masked_prompt"; exit 1; }

    echo "OK: 200, placeholders present, raw PII absent from the masked prompt"
