# デモ動画 台本（日本語版・要約）

英語正本は [SCRIPT.md](SCRIPT.md)。字幕は英語（正本のキャプションを使用）、ナレーションは日本語で可。

## 撮影前チェックリスト

1. `just warm`（Gemma を1台ウォーム、撮影中のみ ≈$3.5/h）
2. `just smoke` を2回（10秒以内で返ることを確認）
3. タブ準備: ①Web UI ②Cloud Run 一覧（プロジェクト ID `all-thinkgs` をヘッダーに映す）③Cloud Trace ④IAM（sa-core でフィルタ）⑤予算 `agentic-fleet-kill-switch`（¥15,000）
4. 撮影後は必ず `just chill`

## 構成（4分）

- **0:00–0:25** 問題提起と信頼境界（Cloud Run 4サービスを見せる）
- **0:25–1:10** PII 入りテキストを送信 → マスク済みプロンプト（⟦PERSON_1⟧ 等）を見せる
- **1:10–1:45** 最終回答と OKF 監査文書（attestation、4つの trust 次元、カード番号は復元されない）
- **1:45–2:15** fail-closed（⟦⟧ 混入は 400、漏洩検知時は draft で本文 withheld）
- **2:15–2:50** 消費面: `/v1/models` で「モデルとして選べる」、Python CLI、（時間があれば）Claude Desktop の MCP
- **2:50–3:25** 実在証明: Cloud Trace の1本のトレース、IAM で sa-core に Firestore 権限が無いこと
- **3:25–4:00** スケールゼロ経済性と ¥15,000 キルスイッチ、締め

## 撮影時の注意

- 例文は必ず偽データ（hanako.sato@example.co.jp / 090-1234-5678 / 4242-…）
- 実在の氏名・メールを画面に出さない
- judge_flagged で拒否されたら「これが正しい動作」と言って構造化 PII の例文で再実行
