---
type: Policy
title: PII masking policy
description: What the gateway must mask before any text crosses the trust boundary, and what a response must satisfy before it is presented to a user.
tags: [pii, security, policy]
status: stable
generated: { by: claude_fleet_agent/opus-4, at: 2026-08-31T17:00:00Z }
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
| Requester-named term        | `⟦CUSTOM_n⟧`                            | exact string match    |

Structured identifiers are detected deterministically so that coverage is auditable and
reproducible. Unstructured entities (names, addresses) are extracted by the self-hosted
Gemma model, which never leaves the boundary. Where the two disagree on an overlapping
span, the deterministic detector wins.

`CUSTOM` is the exception to both: nothing detects it. An unreleased product name or an
internal codename has no lexical form a regex could match and no public meaning a model
could recognise — its confidentiality is a fact about the enterprise, not about the
string. The requester therefore supplies the exact phrase in `mask_terms`, and it is
substituted **before** every detector runs. Matching is case-sensitive, because a
codename's case is part of its identity and folding it would mask ordinary prose nobody
asked to hide. Where a requester-named term overlaps a detected span, the term wins: an
explicit assertion that a string is confidential outranks a heuristic, and splitting the
term would leave part of it in the clear.

# What this is, and is not

The mechanism is **pseudonymization**, not anonymization. A placeholder discloses its
category, and equal values share a placeholder, so a reader of the masked prompt learns
that two mentions refer to the same person even without learning who. Employer, location,
date, role and event context survive masking untouched, and enough of it can identify a
person. Contextual re-identification is a disclosed residual risk, not a solved problem.

# Placeholder stability

Within one request, the same source value always maps to the same placeholder, so the
Core Agent can reason about `⟦PERSON_1⟧` coherently within an answer. The mapping lives
in the Token Vault keyed by the **server-generated request id**, and expires with it.

There is deliberately no cross-request stability and no caller-supplied key. A caller who
can name a vault key can ask the fleet to resolve placeholders belonging to that key, and
validating the key does not remove that; one key per request removes it structurally.

# Reserved syntax

The delimiters `⟦` and `⟧` are reserved to the gateway. A request containing either
character is rejected with 400 before masking: only the tokenizer may mint a placeholder,
and text that arrives already looking like one is a probe at the vault, not data.

# Disclosure policy on release

Secret-bearing categories — `API_KEY`, `AWS_KEY`, `JWT`, `CREDIT_CARD`, `MY_NUMBER` — are
**not** restored into a released answer by default. The caller already holds those values,
and echoing them back through a model round trip only widens where they can be logged or
screenshotted. The placeholder stays in place and the withheld categories are listed in
the answer's `attestation.withheld`. `REHYDRATE_ALLOW_CATEGORIES` can re-enable specific
categories for a deployment with a stated purpose.

`CUSTOM` is **not** in that set and is restored by default. The requester supplied the
term in this same request, so withholding it protects nothing they do not already hold,
while a released answer full of `⟦CUSTOM_1⟧` is unreadable to the person who asked about
their own codename. The guarantee for a requester-named term is that it never crossed the
boundary, not that it never comes back.

# Egress guard

Masking is re-verified immediately before the A2A call to the Core Agent. If the
deterministic detector finds any raw identifier in the outbound text, the request is
refused rather than sent. This is defense in depth: it catches a tokenizer regression or
a missed span before it becomes a disclosure, and it does not depend on the model
behaving correctly.

The guard additionally scans the outbound text for each requester-named term as a literal
string, and the deterministic attester performs the same scan over the Core Agent's
response. Either finding refuses the request under category `CUSTOM`. This is the only
check in the system that can _prove_ the masking applied: every other guard check re-runs
the same patterns that decided the masking and can therefore only catch a fault over
shapes it already knows, whereas a literal comparison catches a failed substitution
outright.

The term list is never persisted to evidence or logs; matched values are stored only in the
TTL'd Token Vault for rehydration, like every masked value. The distinction is exact and
worth stating plainly: the phrases a requester supplies in `mask_terms` are held in memory
for the life of the request and are written nowhere, while a term that actually matched
becomes a vault mapping entry — keyed by request id, expiring with it — because rehydration
has no other way to restore it. The audit record carries `attestation.custom_terms:
{count: N}` — a count, never a term and never a digest of one, because a codename is drawn
from a small guessable space and a hash of it would be a confirmation oracle rather than a
redaction.

# Response requirements

A response may be rehydrated and presented to a user only when **every** gate passes —
see [the leak-check computation](/computations/leak-check.md). The gates, all of which run
before any rehydration:

1. The token mapping exists, is live, and is the exact generation the gateway wrote.
2. The core agent used only placeholders it was given; an invented one fails.
3. The deterministic leak check finds no raw identifier in the tokenized answer.
4. The advisory Gemma judge did not flag a leak and did answer. Its influence is
   asymmetric: `leak: true` or no usable verdict blocks the release, `leak: false` adds no
   trust at all. A probabilistic model may veto; it may never vouch.
5. Every placeholder in the answer resolved (or was deliberately withheld).

A failure at any gate returns no answer body. The exchange is still recorded: the masked
prompt, the tokenized core response, the hashes and the category-level findings are
persisted as `status: draft` with `verified` omitted, so the refusal is auditable. The
failure is surfaced, never silently dropped and never presented as verified.

# What is persisted

Only masked artifacts, keyed by request id: the masked prompt, the core agent's tokenized
response, the OKF document (whose body holds the masked answer), hashes, and
`expires_at`. The rehydrated answer is returned in one API response and never stored.

# Vault lifetime

Token Vault entries carry an absolute expiry and a `generation` counter. The `stale_after`
of every answer equals that expiry: once the mapping is gone, the answer can no longer be
re-derived or re-audited, so it must not be treated as fresh. A response whose generation
no longer matches the one the gateway wrote is refused rather than resolved against the
newer mapping.
