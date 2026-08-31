# 提出用デモ動画

録画ワークフローは、Web UI 編の後に Codex CLI 編が続く英語・1920×1080 の提出用動画を
1 本 `artifacts/demo/` に生成します。生成物は意図的に git 管理から除外しています。

```sh
just demo-video
```

最終出力:

- `privacy-gateway-submission-1080p.mp4`
- `privacy-gateway-submission-1080p.vtt`

MP4 は H.264 映像、AAC ナレーション、選択可能な英語字幕を収録します。macOS の `say` は
1 文ずつ別ファイルとして生成するため、各ブラウザ操作・端末操作の開始時刻へ合わせられます。

## Web UI 編

```sh
just demo-video-web
```

再現性のある録画として、ブラウザから本番と同じ Gateway と Synthesis のコードを通します。
Core と Gemma は既存 E2E の fetch seam を使うため、GPU の warm 状態やクラウド費用に依存しません。
動画では masking を pseudonymization と明記し、4 つの trust dimension を分離して表示し、
OKF v0.2 の監査記録まで見せます。

出力:

- `privacy-gateway-web-1080p-silent.webm`
- `privacy-gateway-web-1080p-silent.mp4`
- `privacy-gateway-web-1080p.mp4`
- `privacy-gateway-web-1080p.vtt`
- `web-narration/*.aiff`

## Codex CLI 編

```sh
just demo-video-codex
```

Asciinema が本物の PTY を記録し、その中で tmux が未変更の対話型 Codex TUI を操作します。
`tmux send-keys` でプロンプトを入力して Enter を押し、処理中表示と回答までを実際の端末操作として収録します。
Gateway と Synthesis は実コード、Core と Gemma は Web UI 編と同じ決定的な E2E seam です。
端末制御ストリームは `agg` で正確に描画し、ffmpeg で 1080p に収めます。デプロイ済みサービスへは
何も送信せず、クラウド費用も発生しません。

実リクエストを繰り返さずに済むよう、キャプチャと描画は分けて実行できます。

```sh
just demo-video-codex-capture
just demo-video-codex-render
```

出力:

- `codex-pty.cast`
- `codex-pty.gif`
- `privacy-gateway-codex-1080p.mp4`
- `privacy-gateway-codex-1080p-silent.mp4`
- `privacy-gateway-codex-1080p.vtt`
- `codex-narration/*.aiff`

元の cast と中間 GIF も MP4 と同じ場所に残します。どちらも最終動画と同じ対話型 TUI
セッションを収録したものです。英語ナレーションは macOS の `say` で 1 文ずつ生成し、最終 MP4 には
AAC 音声と選択可能な英語字幕トラックを収録します。

既存の Web UI 編と CLI 編を録画し直さず結合する場合:

```sh
just demo-video-combine
```

実環境で最終収録する場合は、Codex がローカルの指示コンテキストを送信することと、デプロイ済み GPU
の起動で費用が発生し得ることを明示的に確認したうえで、次を実行します。

```sh
just demo-video-codex-live-capture
just demo-video-codex-render
```
