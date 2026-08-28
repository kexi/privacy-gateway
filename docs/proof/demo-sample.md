# The SCRIPT.md demo sample, end to end

The sample from [docs/demo/SCRIPT.md](../demo/SCRIPT.md) (0:25–1:10) run against the real
deployment on **2026-08-28**, project `all-thinkgs`, region `us-central1`, after the judge
and kill-switch fixes.

The PII is synthetic and allow-listed in `.gitleaks.toml`. Nothing here is real.

## The request

```http
POST /v1/ask
Content-Type: application/json

{"text":"Customer Hanako Sato (hanako.sato@example.co.jp, 090-1234-5678, card
4242-4242-4242-4242) asked for a refund. Draft a short apology email and confirm the
refund of 12800 yen."}
```

## The result — HTTP 200

| Field         | Value                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `request_id`  | `01a045e6-51b6-7d09-8e8f-c7046fabcff9`                                                         |
| `trace_id`    | `4c924d089fe9f8263598ce324e9f73aa`                                                             |
| `trust_tier`  | `machine-confirmed`                                                                            |
| `status`      | `stable`                                                                                       |
| `dimensions`  | `policy_verdict: pass`, `document_status: stable`, `freshness: fresh`, `review_identity: none` |
| `judge`       | `{"leak": false, "categories": []}`                                                            |
| masked counts | `PERSON: 1, EMAIL: 1, PHONE: 1, CREDIT_CARD: 1`                                                |

Other successful runs of the same sample:

| `request_id`                           | `trace_id`                         |
| -------------------------------------- | ---------------------------------- |
| `01a045e5-af9b-7774-8502-3a84b7d943a9` | `6022fc3f83c782c38e3863df83718d97` |
| `01a04636-7ed8-78b7-91a6-f3144dcc2c39` | `905fabdd8213c2c053717aae1d2ba2e6` |

The last of these was recorded after the whole fleet — including the digest-pinned Gemma
image — was redeployed, so it is the run that reflects the final deployed state.

## What Gemini actually received

All four identifiers were replaced before the trust boundary:

```
Customer ⟦PERSON_1⟧ (⟦EMAIL_1⟧, ⟦PHONE_1⟧, card ⟦CREDIT_CARD_1⟧) asked for a refund.
Draft a short apology email and confirm the refund of 12800 yen.
```

## What came back

The disclosure policy is visible in the answer itself. The name and phone were restored;
the **card was not**, because `CREDIT_CARD` is in `DEFAULT_WITHHELD_CATEGORIES` — a secret
the caller already holds has no reason to be echoed through a frontier-model round trip:

```
Subject: Refund Confirmation and Sincere Apologies

Dear Hanako Sato,

Please accept our sincere apologies for the inconvenience that led to your refund
request. …

This email confirms that we have processed a refund of 12,800 yen to your card
⟦CREDIT_CARD_1⟧. Depending on your card issuer's processing times, the funds should
appear in your account within 5 to 10 business days.

If you have any further questions … please do not hesitate to reach out to us at this
email or via 090-1234-5678.
```

Verified on the returned body: the literal card number does **not** appear
(`'4242-4242' in answer` → `False`), and neither does the raw email — the model wrote
"this email" rather than the address.

## Judge reliability after the fix

The systematic defect is gone: the judge no longer vetoes an answer for containing its own
placeholders (see [openai-compat.md](./openai-compat.md), addendum).

Measured on this deployment, same window:

| Sample                                             | Result       |
| -------------------------------------------------- | ------------ |
| `just smoke` sample (name + email + phone)         | **8/8 pass** |
| SCRIPT.md demo sample (adds a credit card, longer) | 2/6 pass     |

The smoke sample, which previously failed almost every time with `judge_flagged`, now
passes consistently. The longer demo sample still flags intermittently, and the same
intermittency appears with the card removed — so it is **not** placeholder-related. It is
residual variance in the advisory judge on longer generated answers, with the same
`categories: []` signature: a leak claim naming no category.

This is a **known remaining limitation, not a regression**, and the failure mode is the
safe one: the fleet refuses rather than releasing. For filming, send the request until a
`machine-confirmed` result renders, or use the shorter smoke-style sample which is stable.
Reducing that variance (a stricter judge schema, or requiring a named category before a
veto counts) is follow-up work, deliberately not attempted under deadline because it
changes the meaning of the veto.
