# OpenAI-compatible endpoint against production

Captured **2026-08-27** against the deployed Gateway
(`https://gateway-agent-turszib42q-uc.a.run.app`), project `all-thinkgs`.

The sample PII is synthetic and allow-listed in `.gitleaks.toml`. Nothing here is real.

## Run 1 — a request with no PII succeeds

This is the run that proves the compatibility surface works end to end.

**Request**

```http
POST /v1/chat/completions
Content-Type: application/json

{"model":"gemma3:12b","messages":[{"role":"user",
  "content":"Reply with JSON only: {\"leak\": true|false}. Does this text contain personal data? Text: Hello world, the weather is nice."}]}
```

**Response — HTTP 200**

```json
{
  "id": "chatcmpl-01a04587-c5e1-78e3-bb58-0f1eb7a93965",
  "object": "chat.completion",
  "created": 1787872923,
  "model": "privacy-gateway",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "{\"leak\": false}" },
      "finish_reason": "stop"
    }
  ],
  "x_privacy_gateway": {
    "request_id": "01a04587-c5e1-78e3-bb58-0f1eb7a93965",
    "trace_id": "003b8bcb93f7cc2da218f61af43bab8e",
    "trust_tier": "machine-confirmed",
    "status": "stable",
    "masked_prompt": "Reply with JSON only: ...",
    "withheld": []
  }
}
```

The shape is OpenAI's (`object`, `choices[].message`, `finish_reason`), so an existing
OpenAI client works unchanged, and the `x_privacy_gateway` extension carries the
`request_id`, `trace_id` and `trust_tier` an auditor needs.

`GET /v1/models` also answers `200`.

## Run 2 — the detector-safe PII sample is refused

The sample the task specified (email + phone, no bare name) reaches every gate and is
then refused by the advisory judge.

**Request**

```http
POST /v1/chat/completions

{"model":"gemma3:12b","messages":[{"role":"user",
  "content":"Draft a reply to the customer at hanako.sato@example.co.jp / 090-1234-5678 confirming her refund."}]}
```

**Response — HTTP 422** (7.5 s)

```json
{
  "error": {
    "message": "the advisory judge flagged a possible leak",
    "type": "invalid_request_error",
    "param": null,
    "code": "judge_flagged",
    "request_id": "01a04596-99b5-7692-9782-1c61eee0b943"
  }
}
```

The refusal is an OpenAI-shaped `error` object, so a standard client surfaces it as a
normal API error rather than a transport failure.

### What the logs show for that request_id

This is the valuable part: the refusal is not a broken pipeline, it is the last gate
vetoing after every earlier one passed.

```json
{"svc":"gateway-agent",  "ev":"openai.compat.chat.start"}
{"svc":"gateway-agent",  "ev":"mask.done",     "counts_by_category":{"EMAIL":1,"PHONE":1}}
{"svc":"gateway-agent",  "ev":"a2a.core.send"}
{"svc":"core-agent",     "ev":"a2a.receive"}
{"svc":"gateway-agent",  "ev":"a2a.core.recv"}
{"svc":"synthesis-agent","ev":"attest.verdict","verdict":"pass","findings":[]}
{"svc":"synthesis-agent","ev":"judge.gemma",   "leak":true,"categories":[]}
{"svc":"synthesis-agent","ev":"release.refused"}
{"svc":"synthesis-agent","ev":"okf.persist",   "verdict":"fail"}
{"svc":"gateway-agent",  "ev":"openai.compat.chat.refused"}
```

Read in order this establishes:

- **Masking happened before the boundary.** `mask.done` counted `EMAIL: 1, PHONE: 1`,
  and Core received the masked text — `core-agent` logs `a2a.receive` and never sees a
  raw value.
- **The deterministic attester passed.** `verdict: pass`, `findings: []`. The
  TypeScript regex check — the only thing that can _pass_ an answer — found no leak.
- **Only the probabilistic judge objected**, with `leak: true` and `categories: []`: a
  leak claim that names no category.
- **The fleet failed closed.** `release.refused` → `422`, nothing released.

This is the documented asymmetry working exactly as `agents/synthesis/src/pipeline.ts`
describes it: _"A probabilistic model may veto; it may not vouch."_

## Open issue: the judge vetoes its own placeholders

Run 2 is not specific to that sample. The advisory judge returns `leak: true` for
essentially every answer that contains `⟦TYPE_N⟧` placeholders, which is most answers
that had any PII to mask — so `just smoke` currently fails with `judge_flagged`.

Evidence from one 10-minute window, same deployment, same model:

| request_id (tail) | answer contains `⟦…⟧`? | `judge.gemma` |
| ----------------- | ---------------------- | ------------- |
| `…c5e1…`          | no                     | `leak: false` |
| `…060c…`          | no                     | `leak: false` |
| `…e163…`          | yes                    | `leak: true`  |
| `…751e…`          | yes                    | `leak: true`  |
| `…0796…`          | yes                    | `leak: true`  |
| `…99b5…`          | yes                    | `leak: true`  |

The judge is told `Text between ⟦ and ⟧ is an already-masked placeholder and is NOT a
leak`, and is doing the opposite. Every such verdict carries `categories: []` — it
asserts a leak while naming no category, which is what a confused classifier looks like
rather than a real detection.

Timeline points at the serving layer, not at the judge code:

- `agents/synthesis/src/agent.ts` (`JUDGE_PROMPT`, `parseJudgeVerdict`) is **unchanged
  since the initial commit** — no regression there.
- Judge verdicts were mostly `leak: false` from 15:40–16:07 on 2026-08-27, then turned
  near-uniformly `leak: true` from 16:34 onward.
- `serving/gemma/Dockerfile` is `FROM ollama/ollama:latest` — **unpinned**. The image
  built at 15:33 runs Ollama **0.33.1**, and its startup log shows llama-server invoked
  with `--chat-template chatml --no-jinja` for a **gemma3** model, plus `--mmproj`
  pointed at the same blob as `--model`.

Gemma 3 has its own chat template; serving it under ChatML with `--no-jinja` means the
system prompt is not framed the way the model expects, which is a plausible mechanism for
a system instruction ("`⟦…⟧` is NOT a leak") being ignored. **Stated as a hypothesis, not
a confirmed root cause** — confirming it needs a direct call to `gemma-serving`, which is
internal-ingress and unreachable from a laptop.

The concrete defect that is certain either way: **`FROM ollama/ollama:latest` is
unpinned**, so the serving runtime can change under the fleet without a commit. Pinning
it to a digest is the first fix, and re-testing the judge on a pinned known-good Ollama
is how to confirm the mechanism above.

Until then the fail-closed behaviour is correct — no PII is released — but the fleet
refuses most real requests, which is a demo-blocking bug.
