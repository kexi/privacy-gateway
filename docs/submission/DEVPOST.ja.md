# Devpost 提出文 下書き（日本語版・要約）

英語正本は [DEVPOST.md](DEVPOST.md)。提出フォームには英語正本を貼る。

- **カテゴリ**: Fortified Enterprise Fleet（Best Architectural Design も対象）
- **一言**: 自前 GPU の Gemma が機密を預かり、Gemini 3.5 はプレースホルダだけで推論。全回答に再実行可能な leak-check attestation（OKF v0.2）が付く。OpenAI 互換でどのツールからも「モデルとして」選べ——実 Codex CLI のフルターン（約 59 KB の指示をチャンク単位でマスク）がウォームで約 30 秒で完走する——Claude Desktop からは MCP で使える。
- **ユーザー定義の秘匿語句**: 未発表の製品名や社内コードネームには検出できる形がないため、依頼者が `mask_terms` で指定すると全検出器より前に ⟦CUSTOM_1⟧ へ置換される。境界の両スキャンがリテラル文字列を探すので、マスキングが機能したことを*証明*できる唯一のチェックになる（他は判定に使ったパターンの再実行にすぎない）。語句リストは evidence にもログにも永続化されず、マッチした値だけが他のマスク済みの値と同様に再水和のため TTL 付き Token Vault に保存される。監査記録は件数のみを残す
- **構成**: Gateway(Gemma/RTX PRO 6000) → A2A → Core(ADK TS + gemini-3.5-flash, Firestore 権限なし) → Synthesis(Gemma, fail-closed ゲート群) → OKF 文書
- **苦労した点**: L4 枯渇→RTX PRO 6000 切替 / gemini-3.5-flash は global エンドポイント限定 / 「拒否時に復元しない」を構造で保証するリファクタ / internal ingress + Direct VPC egress の罠
- **fail closed**: どのゲートが落ちても復元済み回答は返らず、保存されるのはマスク済み evidence のみ。高リスクカテゴリ（カード番号・鍵）は既定で withheld とし、リクエスト単位の明示的なオプトイン（`disclosure_requested` として記録）でのみ復元する。保存される evidence はいずれの場合もマスク済みのまま
- **学び**: 仮名化は匿名化ではない。信頼は「主張」ではなく「再実行できる証明」で示す
- **次の一手（一部は実装済み）**: モデルピッカー用シム `clients/ollama-shim` は実装済み——Claude Desktop の gateway provider が話すのは Ollama プロトコルではなく Anthropic Messages API だと判明したので両方を提供する。リクエスト単位の開示オプトインも実装済みで、呼び出し元は*自分が送った*高リスク値を*自分の*回答に限って復元させられる（デプロイ全体のポリシーは緩めない）。残るのは**マルチモーダル入力** — 現状すべてのサーフェスはテキスト専用で、画像パートは黙って捨てず明示的に拒否する。正規表現とテキストモデルでは画像内の PII を検出・マスク・検証できないためで、誠実にサポートするには境界内 Gemma のビジョン抽出が必要になる。さらに IAP による人間レビュー（human-reviewed tier の解禁）とテナント別の開示ポリシー
- **リンク**: デモ https://privacy-gateway.kexi.dev / リポジトリ / 動画（要記入）
