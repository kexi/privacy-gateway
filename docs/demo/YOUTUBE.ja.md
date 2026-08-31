# デモ動画の YouTube 説明文

> English version: [YOUTUBE.md](YOUTUBE.md)
> 貼り付ける本文は英語正本([YOUTUBE.md](YOUTUBE.md))を使う。この文書は
> 内容の日本語解説です。

## 本文に含めているもの

- 一行ピッチ: 自前ホストの **Gemma 4** が機密をマスクし、**Gemini 3.5 Flash**
  はプレースホルダだけで推論、全回答に再実行可能な leak-check attestation
  (OKF v0.2)が付く
- **All Things Agentic Hackathon** 向けに制作した旨の明記
  (コンテンツボーナスの要件)
- デモで見せる内容の箇条書き: マスキング実演 / A2A 経由の Gemini 推論
  (vault へは IAM で到達不能)/ fail-closed なゲート群と検証付き復元 /
  Cloud Trace の監査証跡 / Google Cloud 上で稼働している証拠
- 実 Codex CLI が約 59 KB のターンを約 30 秒で完走する実測の一文
- リンク 3 本: デモ / Devpost / GitHub
- 技術スタックとハッシュタグ(#AllThingsAgenticHackathon ほか)

## チャプター

英語版末尾のチャプター雛形は [SCRIPT.md](SCRIPT.md) の構成に対応している。
公開前に実際の尺へタイムスタンプを合わせること。
