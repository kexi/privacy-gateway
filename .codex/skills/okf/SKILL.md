---
name: okf
description: Open Knowledge Format (OKF) v0.2 — Google Cloud の Markdown+YAML frontmatter 知識フォーマット（provenance / trust / freshness / lifecycle / attestation）。このリポジトリで次のいずれかに触れるときは必ず先に読むこと: 知識ドキュメント・ポリシー・監査記録(audit record)・Firestore に保存する回答レコード・Synthesis Agent の出力スキーマ・knowledge/ や bundles/ 配下の .md・frontmatter 付き Markdown・sources/generated/verified/status/stale_after/Attested Computation/attester/receipt/trust tier に関する設計や実装・README/ARCHITECTURE で OKF に言及する箇所。
---

# OKF v0.2

共通本体はリポジトリルートの `skills/okf/OKF.md` にある（Claude Code / Codex で共有）。

1. まず `skills/okf/OKF.md` を読む。
2. 仕様の詳細が必要なら `skills/okf/references/SPEC.md` の該当 § を読む。実例は同ディレクトリの `example_*`。
3. 本体の「§4 このプロジェクトでの適用ルール」に従って設計・実装する。
