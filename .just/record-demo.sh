#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "$0")/.." && pwd)
ARTIFACT_DIR="${ROOT_DIR}/artifacts/demo"
PLAYWRIGHT_OUTPUT="${ROOT_DIR}/web/test-results/demo"
WEB_SILENT_MP4_PATH="${ARTIFACT_DIR}/privacy-gateway-web-1080p-silent.mp4"
WEB_NARRATION_DIR="${ARTIFACT_DIR}/web-narration"
WEB_CAPTIONS_SOURCE_PATH="${ROOT_DIR}/docs/DEMO_VIDEO_WEB.vtt"
WEB_CAPTIONS_OUTPUT_PATH="${ARTIFACT_DIR}/privacy-gateway-web-1080p.vtt"
CAST_PATH="${ARTIFACT_DIR}/codex-pty.cast"
TERMINAL_GIF_PATH="${ARTIFACT_DIR}/codex-pty.gif"
TERMINAL_SILENT_MP4_PATH="${ARTIFACT_DIR}/privacy-gateway-codex-1080p-silent.mp4"
CODEX_NARRATION_DIR="${ARTIFACT_DIR}/codex-narration"
CAPTIONS_SOURCE_PATH="${ROOT_DIR}/docs/DEMO_VIDEO_CODEX.vtt"
CAPTIONS_OUTPUT_PATH="${ARTIFACT_DIR}/privacy-gateway-codex-1080p.vtt"
COMBINED_CAPTIONS_SOURCE_PATH="${ROOT_DIR}/docs/DEMO_VIDEO_COMBINED.vtt"
COMBINED_CAPTIONS_OUTPUT_PATH="${ARTIFACT_DIR}/privacy-gateway-submission-1080p.vtt"

mkdir -p "${ARTIFACT_DIR}"

encode-mp4() {
    local source_path="$1"
    local output_path="$2"

    ffmpeg -hide_banner -loglevel error -y -i "${source_path}" \
        -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
        -movflags +faststart "${output_path}"
}

copy-playwright-video() {
    local output_stem="$1"
    local video_path

    video_path=$(find "${PLAYWRIGHT_OUTPUT}" -name video.webm -print -quit)
    if [[ -z "${video_path}" ]]; then
        echo "No Playwright video was produced" >&2
        exit 1
    fi

    cp "${video_path}" "${ARTIFACT_DIR}/${output_stem}.webm"
    encode-mp4 "${video_path}" "${ARTIFACT_DIR}/${output_stem}.mp4"
    echo "Recorded ${ARTIFACT_DIR}/${output_stem}.mp4"
}

record-web() {
    cd "${ROOT_DIR}"
    pnpm -C web exec playwright test demo/web-ui.demo.ts --config playwright.demo.config.ts
    copy-playwright-video "privacy-gateway-web-1080p-silent"
}

speak-sentence() {
    local output_path="$1"
    local sentence="$2"

    say -v Samantha -r 220 -o "${output_path}" "${sentence}"
}

render-web() {
    local video_duration

    mkdir -p "${WEB_NARRATION_DIR}"
    video_duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${WEB_SILENT_MP4_PATH}")
    speak-sentence "${WEB_NARRATION_DIR}/01.aiff" "This gateway protects sensitive data before cloud reasoning begins."
    speak-sentence "${WEB_NARRATION_DIR}/02.aiff" "We enter identity, payment, and private project details."
    speak-sentence "${WEB_NARRATION_DIR}/03.aiff" "Shape detection and explicit terms protect every sensitive value."
    speak-sentence "${WEB_NARRATION_DIR}/04.aiff" "High-risk values remain withheld unless disclosure is explicit."
    speak-sentence "${WEB_NARRATION_DIR}/05.aiff" "The fail-closed gateway pseudonymizes the request before Gemini sees it."
    speak-sentence "${WEB_NARRATION_DIR}/06.aiff" "Four independent dimensions explain the release decision."
    speak-sentence "${WEB_NARRATION_DIR}/07.aiff" "This is pseudonymization, not anonymization."
    speak-sentence "${WEB_NARRATION_DIR}/08.aiff" "The masked pane shows exactly what Gemini received."
    speak-sentence "${WEB_NARRATION_DIR}/09.aiff" "A click traces one protected value across the workflow."
    speak-sentence "${WEB_NARRATION_DIR}/10.aiff" "Safe values return once, while card data remains withheld."
    speak-sentence "${WEB_NARRATION_DIR}/11.aiff" "The OKF record preserves provenance and deterministic leak-check evidence."
    speak-sentence "${WEB_NARRATION_DIR}/12.aiff" "The result is useful, inspectable, and never released through an unsafe fallback."
    cp "${WEB_CAPTIONS_SOURCE_PATH}" "${WEB_CAPTIONS_OUTPUT_PATH}"

    ffmpeg -hide_banner -loglevel error -y \
        -i "${WEB_SILENT_MP4_PATH}" \
        -i "${WEB_NARRATION_DIR}/01.aiff" -i "${WEB_NARRATION_DIR}/02.aiff" \
        -i "${WEB_NARRATION_DIR}/03.aiff" -i "${WEB_NARRATION_DIR}/04.aiff" \
        -i "${WEB_NARRATION_DIR}/05.aiff" -i "${WEB_NARRATION_DIR}/06.aiff" \
        -i "${WEB_NARRATION_DIR}/07.aiff" -i "${WEB_NARRATION_DIR}/08.aiff" \
        -i "${WEB_NARRATION_DIR}/09.aiff" -i "${WEB_NARRATION_DIR}/10.aiff" \
        -i "${WEB_NARRATION_DIR}/11.aiff" -i "${WEB_NARRATION_DIR}/12.aiff" \
        -i "${WEB_CAPTIONS_OUTPUT_PATH}" \
        -filter_complex "[1:a]adelay=600:all=1[a1];[2:a]adelay=3800:all=1[a2];[3:a]adelay=7000:all=1[a3];[4:a]adelay=10200:all=1[a4];[5:a]adelay=13300:all=1[a5];[6:a]adelay=16800:all=1[a6];[7:a]adelay=19500:all=1[a7];[8:a]adelay=23100:all=1[a8];[9:a]adelay=27800:all=1[a9];[10:a]adelay=31200:all=1[a10];[11:a]adelay=35800:all=1[a11];[12:a]adelay=40800:all=1[a12];[a1][a2][a3][a4][a5][a6][a7][a8][a9][a10][a11][a12]amix=inputs=12:duration=longest:normalize=0,apad,atrim=duration=${video_duration}[narration]" \
        -map 0:v:0 -map "[narration]" -map 13:0 \
        -c:v copy -c:a aac -b:a 192k -c:s mov_text \
        -metadata:s:s:0 language=eng -movflags +faststart \
        "${ARTIFACT_DIR}/privacy-gateway-web-1080p.mp4"
}

capture-codex-live() {
    cd "${ROOT_DIR}"
    asciinema record --quiet --return --overwrite --output-format asciicast-v2 \
        --idle-time-limit 2 --window-size 132x34 \
        --command "just codex-e2e tests/codex/pgw-masking.yaml" \
        "${CAST_PATH}"
    echo "Captured ${CAST_PATH}"
}

capture-codex-local() (
    local clean_cast_path="${CAST_PATH}.clean"
    local codex_workspace="${ARTIFACT_DIR}/codex-workspace"
    local fleet_pid

    # Why not inline the trap: named cleanup keeps both validated targets visible.
    # shellcheck disable=SC2329
    cleanup-local-codex() {
        kill "${fleet_pid}" 2>/dev/null || echo "Skipped stopping an exited local fleet"
    }

    cd "${ROOT_DIR}"
    if [[ ! -f "${ROOT_DIR}/agents/gateway/dist/server.js" ]]; then
        just web-build
    fi
    E2E_GATEWAY_PORT=8381 E2E_SYNTHESIS_PORT=8383 \
        E2E_DEMO_CORE_DELAY_MS=4000 \
        pnpm -C web exec tsx e2e/fleet-server.ts >"${ARTIFACT_DIR}/local-fleet.log" 2>&1 &
    fleet_pid=$!
    trap cleanup-local-codex EXIT

    for _attempt in {1..60}; do
        if curl --fail --silent http://127.0.0.1:8381/healthz >/dev/null; then
            break
        fi
        sleep 0.25
    done
    curl --fail --silent http://127.0.0.1:8381/healthz >/dev/null

    mkdir -p "${codex_workspace}/.codex"
    git init --quiet "${codex_workspace}"
    printf '[projects."%s"]\ntrust_level = "trusted"\n' "${codex_workspace}" \
        >"${codex_workspace}/.codex/config.toml"
    DEMO_CODEX_WORKSPACE="${codex_workspace}" \
        DEMO_CODEX_BASE_URL="http://127.0.0.1:8381/v1" \
        TERM="xterm-256color" \
        asciinema record --quiet --overwrite --output-format asciicast-v2 \
        --idle-time-limit 5 --window-size 132x38 \
        --command ".just/codex-demo-tmux.sh" \
        "${CAST_PATH}"

    awk 'NR == 1 { print; next } /Shutting down/ { exit } { print }' \
        "${CAST_PATH}" >"${clean_cast_path}"
    mv "${clean_cast_path}" "${CAST_PATH}"

    if ! rg --quiet 'Referenced placeholders:' "${CAST_PATH}"; then
        echo "The local Codex response marker was not captured" >&2
        exit 1
    fi
    echo "Captured ${CAST_PATH}"
)

render-codex() {
    local video_duration

    if [[ ! -f "${CAST_PATH}" ]]; then
        echo "Missing ${CAST_PATH}; run the Codex capture first" >&2
        exit 1
    fi

    agg --theme github-dark --font-size 21 --line-height 1.35 --fps-cap 30 \
        --idle-time-limit 5 --last-frame-duration 6 --no-loop \
        "${CAST_PATH}" "${TERMINAL_GIF_PATH}"
    ffmpeg -hide_banner -loglevel error -y -i "${TERMINAL_GIF_PATH}" \
        -vf "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=#05070d,fps=30" \
        -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
        -movflags +faststart "${TERMINAL_SILENT_MP4_PATH}"

    mkdir -p "${CODEX_NARRATION_DIR}"
    video_duration=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "${TERMINAL_SILENT_MP4_PATH}")
    speak-sentence "${CODEX_NARRATION_DIR}/01.aiff" "This is Codex in a real pseudo-terminal."
    speak-sentence "${CODEX_NARRATION_DIR}/02.aiff" "We submit an email address through the Privacy Gateway."
    speak-sentence "${CODEX_NARRATION_DIR}/03.aiff" "Gemini receives only pseudonymized text."
    speak-sentence "${CODEX_NARRATION_DIR}/04.aiff" "Deterministic checks pass, and the safe value returns."
    cp "${CAPTIONS_SOURCE_PATH}" "${CAPTIONS_OUTPUT_PATH}"

    ffmpeg -hide_banner -loglevel error -y \
        -i "${TERMINAL_SILENT_MP4_PATH}" \
        -i "${CODEX_NARRATION_DIR}/01.aiff" -i "${CODEX_NARRATION_DIR}/02.aiff" \
        -i "${CODEX_NARRATION_DIR}/03.aiff" -i "${CODEX_NARRATION_DIR}/04.aiff" \
        -i "${CAPTIONS_OUTPUT_PATH}" \
        -filter_complex "[1:a]adelay=600:all=1[a1];[2:a]adelay=4000:all=1[a2];[3:a]adelay=7400:all=1[a3];[4:a]adelay=10000:all=1[a4];[a1][a2][a3][a4]amix=inputs=4:duration=longest:normalize=0,apad,atrim=duration=${video_duration}[narration]" \
        -map 0:v:0 -map "[narration]" -map 5:0 \
        -c:v copy -c:a aac -b:a 192k -c:s mov_text \
        -metadata:s:s:0 language=eng -movflags +faststart \
        "${ARTIFACT_DIR}/privacy-gateway-codex-1080p.mp4"
    echo "Recorded ${ARTIFACT_DIR}/privacy-gateway-codex-1080p.mp4"
}

combine-demo() {
    cp "${COMBINED_CAPTIONS_SOURCE_PATH}" "${COMBINED_CAPTIONS_OUTPUT_PATH}"
    ffmpeg -hide_banner -loglevel error -y \
        -i "${ARTIFACT_DIR}/privacy-gateway-web-1080p.mp4" \
        -i "${ARTIFACT_DIR}/privacy-gateway-codex-1080p.mp4" \
        -i "${COMBINED_CAPTIONS_OUTPUT_PATH}" \
        -filter_complex "[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a]" \
        -map "[v]" -map "[a]" -map 2:0 \
        -c:v libx264 -preset medium -crf 18 -pix_fmt yuv420p \
        -c:a aac -b:a 192k -c:s mov_text \
        -metadata:s:a:0 language=eng -metadata:s:s:0 language=eng \
        -movflags +faststart "${ARTIFACT_DIR}/privacy-gateway-submission-1080p.mp4"
    echo "Recorded ${ARTIFACT_DIR}/privacy-gateway-submission-1080p.mp4"
}

case "${1:-}" in
    web)
        record-web
        render-web
        ;;
    web-render)
        render-web
        ;;
    codex-capture)
        capture-codex-local
        ;;
    codex-live-capture)
        capture-codex-live
        ;;
    codex-render)
        render-codex
        ;;
    codex)
        capture-codex-local
        render-codex
        ;;
    combine)
        combine-demo
        ;;
    submission)
        record-web
        render-web
        capture-codex-local
        render-codex
        combine-demo
        ;;
    *)
        echo "Usage: $0 {web|web-render|codex-capture|codex-live-capture|codex-render|codex|combine|submission}" >&2
        exit 2
        ;;
esac
