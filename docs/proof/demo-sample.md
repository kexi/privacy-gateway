# A full gateway exchange, end to end

One request run against the live deployment on **2026-08-30** — base URL
`https://privacy-gateway.kexi.dev`, project `all-thinkgs`, region `us-central1` — after the
judge and kill-switch fixes.

The PII is synthetic and allow-listed in `.gitleaks.toml`. Nothing here is real.

The full response for this request is committed alongside as
[`gateway-answer.json`](./gateway-answer.json) (with `answer` stripped) and
[`gateway-answer.okf.md`](./gateway-answer.okf.md).

## The request

`POST /v1/ask` with a body of the shape `{"text": "…"}`. The cleartext prompt is not
reproduced here — it is the one artifact this repository deliberately never stores, and
only the masked form below is retained. Its shape is readable from the masked prompt: a
short order-confirmation request naming a person, an email address, a phone number, a
payment card, an API key and an IPv4 address.

## The result — HTTP 200

| Field         | Value                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `request_id`  | `01a05302-656b-735f-88ed-2e3dd5225497`                                                         |
| `trace_id`    | `c057cdb3782dd239bbb772aa0ee268e9`                                                             |
| `trust_tier`  | `machine-confirmed`                                                                            |
| `status`      | `stable`                                                                                       |
| `dimensions`  | `policy_verdict: pass`, `document_status: stable`, `freshness: fresh`, `review_identity: none` |
| `judge`       | `{"leak": false, "categories": []}`                                                            |
| masked counts | `PERSON: 1, EMAIL: 1, PHONE: 1, CREDIT_CARD: 1, API_KEY: 1, IPV4: 1`                           |
| `core_actor`  | `core_agent/gemini-3.5-flash`                                                                  |
| `withheld`    | `API_KEY`, `CREDIT_CARD`                                                                       |

Six identifiers across six categories were detected and masked, and the whole exchange
completed with `machine-confirmed` — the judge did not veto.

## What Gemini actually received

Every identifier was replaced before the trust boundary
(`GET /v1/requests/01a05302-656b-735f-88ed-2e3dd5225497/masked-prompt.md`):

```
Draft a short reply to ⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧) confirming his order. His card
⟦CREDIT_CARD_1⟧ and API key ⟦API_KEY_1⟧ were on file, from ⟦IPV4_1⟧.
```

## What Core sent back

The tokenized response
(`GET /v1/requests/01a05302-656b-735f-88ed-2e3dd5225497/core-response.md`) — the input the
leak check ran over. It carries only placeholders, never a raw value:

```
Subject: Order Confirmation

Hi ⟦PERSON_1⟧,

This is a quick note to confirm that your recent order has been successfully processed.

We have used your card on file (⟦CREDIT_CARD_1⟧) and applied your API key ⟦API_KEY_1⟧ for
this transaction, authorized from IP address ⟦IPV4_1⟧.

If you have any questions or need further assistance, please feel free to reply directly
to this email (⟦EMAIL_1⟧) or call us at ⟦PHONE_1⟧.

Best regards,

[Your Name/Company]
```

## What the caller got

The disclosure policy is visible in the returned answer. The name, email, phone and IP
were rehydrated; the **card and the API key were not**, because `CREDIT_CARD` and
`API_KEY` are in `DEFAULT_WITHHELD_CATEGORIES` — a secret the caller already holds has no
reason to be echoed back through a frontier-model round trip. Those two placeholders
survive verbatim in the released text:

```
Subject: Order Confirmation

Hi Taro Yamada,

… We have used your card on file (⟦CREDIT_CARD_1⟧) and applied your API key ⟦API_KEY_1⟧
for this transaction, authorized from IP address 203.0.113.42.

If you have any questions … please feel free to reply directly to this email
(taro@example.co.jp) or call us at 090-1234-5678.
```

`attestation.withheld` records `["API_KEY", "CREDIT_CARD"]`, and the stored OKF document
states the same in prose: _"The disclosure policy kept these categories masked in the
released answer: `API_KEY`, `CREDIT_CARD`."_ A caller cannot get those two categories back
by asking differently; the withholding is applied at rehydration, not negotiated.

## The attestation

From the OKF `attestation` block — every digest is a real 64-hex value:

| Field                  | Value                                                              |
| ---------------------- | ------------------------------------------------------------------ |
| `verdict`              | `pass`                                                             |
| `checked_at`           | `2026-08-30T14:11:06Z`                                             |
| `masked_prompt_sha256` | `588a0f386c5b3e52c5336bf4430bd33285a9ea2079990ca7df22d2f798e27d1f` |
| `core_response_sha256` | `43047d13d883e6f006932866d6d02dab780215062734f5ddfb0252b096007522` |
| `attester_sha256`      | `8b427a667e6426be7061777d8c7952e57a816b8fbcd0410fdafea2e737529ce9` |
| `computation_sha256`   | `efa7e03c46f5158efed2641a4988cb7f49a32792a67d563826be070946d6cdbc` |

`verified[].by` is `process:leak-check@8b427a667e64` — the deterministic TypeScript
attester, never an LLM actor. Replay it with
`just verify-answer 01a05302-656b-735f-88ed-2e3dd5225497`.

## Consistency

`consistency.ok` is `true` with `invented_tokens: []`: every placeholder the core agent
used was one the gateway actually minted. All six known tokens were used, and Core
invented none — a model that fabricates a `⟦PERSON_9⟧` the vault never issued is caught
here rather than rehydrated into nothing.

## Judge behaviour on this deployment

The judge returned `{"leak": false, "categories": []}` and the answer was released. Since
the fix that strips well-formed placeholders before the judge sees them (see
[openai-compat.md](./openai-compat.md), addendum), the judge no longer vetoes an answer
for containing its own placeholders.

The judge's flag is now **terminal**: `leak: true` always refuses with `judge_flagged`
(HTTP 422), and no re-roll can turn a flag into a release. See
[README.md](./README.md#resolved-postmortems) and `docs/ARCHITECTURE.md`.
