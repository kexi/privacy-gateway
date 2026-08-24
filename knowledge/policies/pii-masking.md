---
type: Policy
title: PII masking policy
description: What the gateway must mask before any text crosses the trust boundary, and what a response must satisfy before it is presented to a user.
tags: [pii, security, policy]
status: stable
generated: { by: human:kei, at: 2026-08-24T00:00:00Z }
verified:
  - { by: human:kei, at: 2026-08-24T00:00:00Z }
---

# Scope

This policy governs every request that the Gateway Agent forwards to the Core Agent, and
every response the Synthesis Agent returns to a user. The Core Agent runs on a commercial
frontier model outside the trust boundary; the Gateway and Synthesis agents, the Gemma
serving endpoint, and the Token Vault run inside it.

# What must be masked

Before any text leaves the boundary, the following must be replaced by an opaque
placeholder of the form `⟦CATEGORY_N⟧`:

| Category                    | Placeholder                             | Detection             |
| --------------------------- | --------------------------------------- | --------------------- |
| Email address               | `⟦EMAIL_n⟧`                             | regex                 |
| Phone number (JP and E.164) | `⟦PHONE_n⟧`                             | regex                 |
| Credit card number          | `⟦CREDIT_CARD_n⟧`                       | regex + Luhn          |
| Japanese My Number          | `⟦MY_NUMBER_n⟧`                         | regex, 12 digits      |
| IPv4 address                | `⟦IPV4_n⟧`                              | regex + octet range   |
| API keys and secrets        | `⟦API_KEY_n⟧`, `⟦AWS_KEY_n⟧`, `⟦JWT_n⟧` | regex                 |
| Person name                 | `⟦PERSON_n⟧`                            | Gemma span extraction |
| Postal address              | `⟦ADDRESS_n⟧`                           | Gemma span extraction |

Structured identifiers are detected deterministically so that coverage is auditable and
reproducible. Unstructured entities (names, addresses) are extracted by the self-hosted
Gemma model, which never leaves the boundary. Where the two disagree on an overlapping
span, the deterministic detector wins.

# Placeholder stability

Within a session, the same source value must always map to the same placeholder, so that
the Core Agent can reason about `⟦PERSON_1⟧` coherently across a multi-turn exchange. The
mapping lives in the Token Vault, keyed by session, and expires with it.

# Egress guard

Masking is re-verified immediately before the A2A call to the Core Agent. If the
deterministic detector finds any raw identifier in the outbound text, the request is
refused rather than sent. This is defense in depth: it catches a tokenizer regression or
a missed span before it becomes a disclosure, and it does not depend on the model
behaving correctly.

# Response requirements

A response may be rehydrated and presented to a user only when the leak check attests
cleanly — see [the leak-check computation](/computations/leak-check.md). The check runs on
the core agent's tokenized answer, before rehydration, and asks whether the model
introduced any raw identifier of its own beyond the placeholders it was given. A response
containing any such identifier is recorded as `status: draft` with the failure surfaced,
never silently dropped and never presented as verified.

# Vault lifetime

Token Vault entries carry an absolute expiry. The `stale_after` of every answer produced
from a session equals that expiry: once the mapping is gone, the answer can no longer be
re-derived or re-audited, so it must not be treated as fresh.
