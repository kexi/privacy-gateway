---
name: pgw-client
description: Privacy-Preserving Gateway を外部から利用する方法（消費面）。次のいずれかに触れるときに読むこと: `POST /v1/ask` / OpenAI 互換エンドポイント（`/v1/chat/completions`, `/v1/models`, `x_privacy_gateway`, stream）・MCP サーバ（`clients/mcp`, `pgw_ask` / `pgw_evidence` / `pgw_verify`）・Python CLI（`clients/python/pgw.py`）・attestation の replay / digest 検証・クライアント側での trust tier 導出・拒否（refusal）のクライアントへの見え方。
---

# Privacy Gateway クライアント

共通本体はリポジトリルートの `skills/pgw-client/CLIENT.md` にある（Claude Code / Codex で共有）。

1. まず `skills/pgw-client/CLIENT.md` を読む。
2. 4 つの消費面（native / OpenAI 互換 / MCP / Python CLI）のうち該当するものに従う。
3. 保証の説明では §5 に従うこと: マスキングは pseudonymization であって anonymization ではなく、
   trust tier は保存せず導出する。過大な主張をしない。
