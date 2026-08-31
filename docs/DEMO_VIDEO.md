# Submission demo video

The recording workflow produces one English, 1920×1080 submission video under
`artifacts/demo/`. It shows the browser workflow first and the Codex CLI workflow
second. Generated files are intentionally git-ignored.

```sh
just demo-video
```

Final output:

- `privacy-gateway-submission-1080p.mp4`
- `privacy-gateway-submission-1080p.vtt`

The MP4 carries H.264 video, AAC narration, and a selectable English subtitle
track. macOS `say` generates each sentence separately so its start time matches
the corresponding browser or terminal action.

## Browser workflow

```sh
just demo-video-web
```

This deterministic recording drives the production Gateway and Synthesis code
through the browser. It uses the existing E2E fetch seam for Core and Gemma, so
recording does not depend on GPU warm state or cloud spend. The video explicitly
calls the masking pseudonymization, keeps the four trust dimensions separate,
and shows the OKF v0.2 audit record.

Outputs:

- `privacy-gateway-web-1080p-silent.webm`
- `privacy-gateway-web-1080p-silent.mp4`
- `privacy-gateway-web-1080p.mp4`
- `privacy-gateway-web-1080p.vtt`
- `web-narration/*.aiff`

## Codex CLI workflow

```sh
just demo-video-codex
```

Asciinema records a real PTY while tmux operates the interactive, unmodified
Codex TUI: `tmux send-keys` types the prompt and presses Enter, then the recording
shows both the in-progress state and answer. Gateway and Synthesis are real; Core
and Gemma use the same deterministic E2E seam as the browser recording. `agg`
renders the terminal control stream accurately before ffmpeg places it in a
1080p frame. Nothing is sent to the deployed service and the recipe incurs no
cloud cost.

Capture and rendering can be split to avoid repeating the live request:

```sh
just demo-video-codex-capture
just demo-video-codex-render
```

Outputs:

- `codex-pty.cast`
- `codex-pty.gif`
- `privacy-gateway-codex-1080p.mp4`
- `privacy-gateway-codex-1080p-silent.mp4`
- `privacy-gateway-codex-1080p.vtt`
- `codex-narration/*.aiff`

The original cast and an intermediate GIF remain beside the MP4. They contain
the same interactive TUI session shown in the final video. macOS `say` produces
one English sentence per AIFF file; the final MP4 carries AAC audio and a
selectable English caption track.

To combine existing narrated browser and CLI videos without recording again:

```sh
just demo-video-combine
```

For a final live capture, after explicitly reviewing that Codex sends its local
instruction context and that waking the deployed GPU may incur cost, run:

```sh
just demo-video-codex-live-capture
just demo-video-codex-render
```
