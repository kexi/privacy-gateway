# YouTube description for the demo video

> 日本語版: [YOUTUBE.ja.md](YOUTUBE.ja.md)

Paste the block below into the YouTube video description as is. Adjust the
chapter timestamps to the final cut before publishing.

---

**Privacy Gateway — frontier reasoning, closed-model custody**

Private in, powerful out: an auditable AI gateway where self-hosted **Gemma 4**
masks your secrets, **Gemini 3.5 Flash** reasons over placeholders only, and
every answer ships with a replayable leak-check attestation (OKF v0.2).

This demo was created for the **All Things Agentic Hackathon** (Google Cloud ×
Devpost). It shows:

• PII being detected and swapped for typed placeholders (⟦PERSON_1⟧,
⟦EMAIL_1⟧…) before anything leaves the trust boundary
• Gemini reasoning over the masked prompt via the A2A protocol — its service
account can't even reach the token vault (IAM, not convention)
• Deterministic leak checks + a veto-only Gemma judge gating the release, then
verified rehydration
• The audit trail: one request = one Cloud Trace trace, masked evidence only,
digests you can replay
• The whole fleet running on Google Cloud (Cloud Run + Cloud Run GPU,
Firestore, Vertex AI)

Bonus: the real Codex CLI runs against the gateway as its model — a full
~59 KB turn comes back masked, reasoned and verified in ~30 seconds.

🔗 Try it: https://privacy-gateway.kexi.dev
🔗 Devpost: https://devpost.com/software/privacy-gateway
🔗 Code: https://github.com/kexi/privacy-gateway

Built with: ADK TypeScript · A2A · Gemini 3.5 Flash (Vertex AI) · Gemma 4 12B
(Ollama, Cloud Run GPU RTX PRO 6000) · Firestore · Terraform · OpenTelemetry ·
MCP · OKF v0.2

#AllThingsAgenticHackathon #GoogleCloud #Gemini #Gemma #ADK

---

## Optional chapters

Fill in the timestamps from the final cut; the beats follow
[SCRIPT.md](SCRIPT.md):

```
00:00 The problem — prompts carry customer data
00:00 The fleet on Cloud Run (Console, project visible)
00:00 Masking a request live (placeholders, vault)
00:00 Gates and a refusal — fail closed, for real
00:00 One request, one Cloud Trace trace
00:00 Wrap-up — pseudonymization with receipts
```
