# Devpost 提出文 下書き（日本語版・要約）

英語正本は [DEVPOST.md](DEVPOST.md)。提出フォームには英語正本を貼る。

- **カテゴリ**: Fortified Enterprise Fleet（Best Architectural Design も対象）
- **一言**: 自前 GPU の Gemma が機密を預かり、Gemini 3.5 はプレースホルダだけで推論。全回答に再実行可能な leak-check attestation（OKF v0.2）が付く。OpenAI 互換でどのツールからも「モデルとして」選べ、Claude Desktop からは MCP で使える。
- **構成**: Gateway(Gemma/RTX PRO 6000) → A2A → Core(ADK TS + gemini-3.5-flash, Firestore 権限なし) → Synthesis(Gemma, fail-closed ゲート群) → OKF 文書
- **苦労した点**: L4 枯渇→RTX PRO 6000 切替 / gemini-3.5-flash は global エンドポイント限定 / 「拒否時に復元しない」を構造で保証するリファクタ / internal ingress + Direct VPC egress の罠
- **学び**: 仮名化は匿名化ではない。信頼は「主張」ではなく「再実行できる証明」で示す
- **次の一手（一部は実装済み）**: モデルピッカー用シム `clients/ollama-shim` は実装済み——Claude Desktop の gateway provider が話すのは Ollama プロトコルではなく Anthropic Messages API だと判明したので両方を提供する。残りは IAP による人間レビュー（human-reviewed tier の解禁）とテナント別の開示ポリシー
- **リンク**: デモ https://gateway-agent-turszib42q-uc.a.run.app / リポジトリ / 動画（要記入）
