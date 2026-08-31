#!/bin/bash
set -euo pipefail

if [[ -z "${DEMO_CODEX_WORKSPACE:-}" || -z "${DEMO_CODEX_BASE_URL:-}" ]]; then
    echo "DEMO_CODEX_WORKSPACE and DEMO_CODEX_BASE_URL are required" >&2
    exit 2
fi

SESSION_NAME="codex-demo-${PPID}"
PROMPT="Acknowledge test@example.com in one concise sentence."

cleanup-tmux() {
    if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
        tmux kill-session -t "${SESSION_NAME}"
    fi
}
trap cleanup-tmux EXIT

tmux new-session -d -s "${SESSION_NAME}" -x 132 -y 38 -- \
    env TERM=xterm-256color NO_COLOR=1 \
    CODEX_HOME="${DEMO_CODEX_WORKSPACE}/.codex" \
    CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT=1 \
    codex \
    --no-alt-screen \
    --enable skip_host_skill_discovery \
    --disable apps \
    --disable browser_use \
    --disable code_mode_host \
    --disable computer_use \
    --disable image_generation \
    --disable plugins \
    --sandbox read-only \
    -C "${DEMO_CODEX_WORKSPACE}" \
    -c 'model="privacy-gateway"' \
    -c 'model_provider="pgw"' \
    -c 'model_context_window=65536' \
    -c 'model_max_output_tokens=8192' \
    -c 'suppress_unstable_features_warning=true' \
    -c 'model_providers.pgw.name="Privacy Gateway"' \
    -c "model_providers.pgw.base_url=\"${DEMO_CODEX_BASE_URL}\"" \
    -c 'model_providers.pgw.wire_api="responses"'
tmux set-option -t "${SESSION_NAME}" status off

(
    sleep 4
    tmux send-keys -t "${SESSION_NAME}" -l "${PROMPT}"
    sleep 1
    tmux send-keys -t "${SESSION_NAME}" Enter
    sleep 12
    tmux send-keys -t "${SESSION_NAME}" C-c
    sleep 1
    tmux send-keys -t "${SESSION_NAME}" C-c
) &

tmux attach-session -t "${SESSION_NAME}"
