# Codex CLI end-to-end scenarios

Proof that a real, unmodified third-party agent CLI can select this fleet as its
model. [`pitty`](https://github.com/kexi/pitty) drives `codex exec` inside a real
pseudo-terminal and asserts on the streamed output.

> **Which one to run.** Day to day, run **`just codex-smoke`** only. The full
> **`just codex-e2e`** is reserved for the **final pre-submission / pre-release
> check** — it drives the real CLI, whose turn forwards ~58 KiB into masking (measured) and has to be
> masked through the single GPU before the turn even starts.

```sh
just codex-smoke                            # routine: the wire contract, small payload
just codex-e2e                              # final check: both real-CLI scenarios
just codex-e2e tests/codex/pgw-smoke.yaml   # one of them
```

| Scenario             | Recipe        | What it guarantees                                                                                                                                                                                        |
| -------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pgw-responses.yaml` | `codex-smoke` | The Responses API contract Codex depends on: an SSE stream that opens with `response.created`, carries a per-run nonce, and terminates with `response.completed`. No CLI, so no large instruction prompt. |
| `pgw-smoke.yaml`     | `codex-e2e`   | Codex reaches the fleet through the Responses API and prints an answer, exiting 0.                                                                                                                        |
| `pgw-masking.yaml`   | `codex-e2e`   | A prompt containing an email address round-trips: a per-run nonce and the address both come back, so masking and rehydration are transparent to the client.                                               |

## The heavy path, and its known limit

`codex-e2e` is a **load** test as much as a protocol test. The Codex CLI sends a
large turn — its instruction block, workspace rules, policy text, plus the tool
schemas it declares — and what must be scanned for unstructured PII is the part
the gateway actually forwards into masking.

**Those are not the same number, and the distinction matters.** The Responses
mapping flattens `instructions` plus the message turns into one text; the
top-level `tools` array is accepted and **ignored**, as are `reasoning`,
`include`, `store` and the rest. So the raw body is larger than what is masked,
and any latency estimate has to start from the forwarded figure. The gateway logs
both on every request, so this is measured rather than assumed:

```
jq 'select(.event=="openai.compat.responses.start")
    | {request_id, raw_body_bytes, forwarded_text_bytes}'
```

Divide `forwarded_text_bytes` by the deployed `EXTRACTION_CHUNK_BYTES` (4000) for
the chunk count, which fans out four at a time across the four llama.cpp slots of
one GPU — a global cap, held across bisection too. A **cold fleet's first CLI turn
can still exceed the 240 s request deadline**, because the scale-from-zero case
also waits for Ollama to load `gemma4:12b`. That is a known capacity limit of a
single-GPU deployment, not a defect in the fleet's logic: the gateway either
answers or refuses cleanly, and never degrades its masking to go faster.

Two things make repeat turns much cheaper. The gateway keeps an in-process LRU of
already-extracted chunks, and the CLI's preamble is byte-identical between turns,
so a warm instance re-extracts only what changed. `just warm` beforehand removes
the model-load component as well. If a run does time out, `just codex-smoke` is
the check that tells you whether the protocol still works.

The routine scenario exists because bundling the two meant a wire-format
regression and a GPU capacity limit produced the same red.

## Prerequisites

- **`~/.codex/pgw.config.toml`** declaring the `pgw` provider with
  `wire_api = "responses"` (Codex ≥ 0.149 rejects `wire_api = "chat"`, and
  rejects `[profiles.*]` inside `config.toml` — hence the separate file). It must
  also carry `model_context_window = 65536` and `model_max_output_tokens = 8192`;
  without them Codex warns `Model metadata for privacy-gateway not found.
Defaulting to fallback metadata` and guesses a context window for an id it does
  not recognise. See the Codex section of `skills/pgw-client/CLIENT.md`.
- **A logged-in `codex` CLI.** The scenarios spawn the binary on `PATH`; Codex
  still needs its own credentials to start, even though the turn itself is
  served by the gateway.
- **A reachable gateway** at the `base_url` in that profile.

## Why a PTY

`codex exec` renders a live status line and flushes its final answer differently
when it is not attached to a terminal. Piping stdout would make the test assert
on different bytes than a human sees, so pitty allocates a genuine PTY.

## Why this is not in CI

These scenarios hit the **live** fleet. Every run wakes a GPU-backed Cloud Run
instance that bills until it idles out (~15 minutes after the last request), and
a cold start costs roughly two minutes before the masking pass even begins —
hence the 240s timeouts. Running that on every push would spend real money to
re-prove something the mocked suites already cover: `pnpm -r test` covers the
masking and gate logic, and `just web-e2e` covers the browser path with Core and
Gemma mocked over HTTP. This is the one test that is deliberately manual,
because it is the one that cannot be mocked — its entire value is that nothing
in the chain is a stand-in.

## Two traps these scenarios hit

**`expect` does not expand variables — so the scenarios are rendered first.**
pitty v1.2.2 interpolates `${VAR}` in `spawn` and `send`, but **not** inside an
`expect` block: an assertion written as `contains: 'ACK ${PGW_NONCE}'` compares
against those literal characters and can never match. That is not a weak
assertion, it is an impossible one, and both scenarios used to work around it —
`pgw-responses.yaml` asserted on the fixed prefix `"text":"ACK PGW` and
`pgw-masking.yaml` asserted on a string nothing could produce.

Both now carry a `__PGW_NONCE__` marker instead, and `.just/render-scenario.sh`
substitutes the run's actual nonce into a temp copy before pitty reads it, so the
**whole** nonce appears on both the request side and the assertion side. What
this proves is now what it says: the reply contains this run's nonce, so it
cannot be a cached, replayed or invented answer.

**A nonce must not look like PII.** The nonce used to be
`PGW-$(date +%s)-$RANDOM`. That long run of digits is what a card number looks
like, so the tokenizer detected it as `CREDIT_CARD`, masked it, and — because
`CREDIT_CARD` is a withheld category — never rehydrated it. The scenario failed
against a fleet that was behaving exactly as designed. The nonce is now letters
only.

## What the masking scenario does not prove

It asserts the address comes back, because rehydration is supposed to return it.
It cannot see whether the address was masked _in flight_. That evidence lives in
the gateway: `/v1/requests/<request_id>` holds the masked prompt, and
`just verify-answer <request_id>` replays the attestation digests.
