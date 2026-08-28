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

---

## Addendum (2026-08-28): fixed deterministically

The judge no longer sees placeholders at all.

The hypothesis above — that serving Gemma 3 under `--chat-template chatml --no-jinja`
made it ignore the "`⟦…⟧` is NOT a leak" instruction — is plausible and remains
unconfirmed, because confirming it needs a direct call to the internal-ingress
`gemma-serving`. It was not worth confirming: the instruction was a _request_ to the
model, and the fix replaces it with a _guarantee_.

**Every well-formed placeholder (`⟦[A-Z_]+_\d+⟧`) is stripped from the text before the
judge is called** (`stripPlaceholders`, `packages/common/src/tokenizer.ts`, applied in
`createLeakJudge`). The question the model now answers is only ever "does this residual
prose contain personal data". Placeholders are not leaks by construction, and the
deterministic attester has already validated the ones present — so removing them takes
away nothing the judge was capable of usefully deciding.

Three properties keep the fix from weakening the gate:

- **Real PII still flags.** Stripping removes only the masked spans, so an unmasked value
  is still in front of the model and its veto still blocks the release.
- **A malformed near-placeholder is left in view.** `⟦EMAIL⟧` has no index, so it is not
  something this system minted and is still judged.
- **The asymmetric veto is unchanged.** `leak: true` or an unusable answer blocks;
  `leak: false` adds no trust. The attester remains the only thing that can _pass_ an
  answer. `judge_unavailable` still refuses.

Covered by `agents/synthesis/test/judge.test.ts` (which asserts the bytes that reach the
wire, not just the verdict) and `packages/common/test/tokenizer.test.ts`.

The prompt was updated to match, since a prompt that describes a world the model is not
in is its own hazard: it now says the text has already been masked and that gaps are
expected.

## healthz: `/healthz` 404s on `*.run.app`, and the app is not at fault

A separate reported defect: the deployed gateway answered `GET /healthz` with `404` while
`GET /v1/models` answered `200` on the same revision. The route exists at
`agents/gateway/src/server.ts:197` and is registered before every other mount.

**The request never reaches the container.** The 404 is a Google Front End HTML error page
(`Error 404 (Not Found)!!1`, `robot.png`), and it carries none of the headers the app
stamps on every response:

| Path                      | Status | `x-powered-by: Express` | Body                                |
| ------------------------- | ------ | ----------------------- | ----------------------------------- |
| `/healthz`                | `404`  | **absent**              | Google HTML error page              |
| `/healthz/`               | `200`  | present                 | `{"status":"ok","agent":"gateway"}` |
| `/HEALTHZ`                | `200`  | present                 | `{"status":"ok","agent":"gateway"}` |
| `/definitely-not-a-route` | `404`  | present                 | the app's own 404                   |

A trailing slash or a change of case reaches the app and answers correctly, which rules
out the route, the routing order, the JSON middleware and the compat router.

The decisive check is the IAM-closed `kill-switch` service, where **every** path returns
`403` because IAM rejects before the app runs — except bare `/healthz`, which returns
`404`. The interception therefore sits upstream of even the IAM check:

```
kill-switch:  /healthz  -> 404      <- intercepted before IAM
              /healthz/ -> 403
              /readyz   -> 403
              /anything -> 403
```

Confirmed against the built image locally: `docker build -f agents/gateway/Dockerfile` then
`curl /healthz` answers `200` with the correct JSON body. Same image, same code — the
difference is only whether `*.run.app` is in front of it.

So there is **no application bug to fix**, and no code change was made for it. The exact
path `/healthz` is reserved by the platform on `*.run.app` domains. What was added is a
regression test that boots the compiled `dist/server.js` and asserts the route is bound
(`agents/gateway/test/dist_healthz.test.ts`), following the `dist_attestation` precedent —
so that a genuine packaging regression, which the deployment could not have distinguished
from this interception, cannot pass unnoticed.

For an external liveness probe against the deployed service, use `/healthz/` (trailing
slash) or `/v1/models`. Cloud Run's own startup/liveness probes are unaffected: they
address the container directly and never traverse the front end.

### The Ollama base image is pinned

Independently certain, and fixed: `serving/gemma/Dockerfile` was `FROM ollama/ollama:latest`.
It is now pinned to `ollama/ollama:0.33.1@sha256:317a9773…` — by **digest**, because tags
are mutable and a tag alone would not have prevented what happened. `0.33.1` is the
current stable release and the version the fleet was observed running, so this pins the
deployment to a known state rather than combining a bug fix with an untested version bump.
