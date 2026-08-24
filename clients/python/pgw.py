# /// script
# requires-python = ">=3.13"
# dependencies = ["httpx"]
# ///
"""Command-line client for the Privacy-Preserving Gateway.

A deliberately small, dependency-light example: the gateway speaks ordinary
JSON over HTTP, so consuming the fleet needs no SDK and no shared runtime with
the agents. This file exists to demonstrate exactly that.

Usage:
    uv run clients/python/pgw.py ask "text" [--gateway URL]
    uv run clients/python/pgw.py evidence <request_id> [--gateway URL] [--json]
    uv run clients/python/pgw.py verify <request_id> [--base URL]

There is no session argument: the gateway mints one id per request and rejects a
body carrying ``session_id``.

The trust tier is derived here, on the client, from the OKF ``verified`` field
rather than read from the server's response: OKF SPEC §5.3 requires the tier to
be derived and never stored, and a client that re-derives it proves the property
holds end to end.

``verify`` goes further: it re-runs the leak-check scan over the masked artifacts
the gateway serves and checks **every** digest the answer records — the two
artifact hashes against the bytes the gateway serves, and the attester and
computation hashes against the bundle files in this checkout — plus the request
id and the verdict. A digest that is not 64 lowercase hex characters fails
outright rather than being printed and ignored.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from typing import Any

import httpx

DEFAULT_GATEWAY = os.getenv("GATEWAY_URL", "http://localhost:8081")
TIMEOUT_SECONDS = float(os.getenv("PGW_TIMEOUT_SECONDS", "180"))

TRUST_UNVERIFIED = "unverified"
TRUST_MACHINE_CONFIRMED = "machine-confirmed"
TRUST_HUMAN_REVIEWED = "human-reviewed"

# Matches one `by:` entry of the OKF frontmatter's `verified` list. A full YAML
# parser is avoided so the script keeps a single dependency; only this one field
# is needed, and anything unparseable simply yields no verifiers.
_VERIFIED_BLOCK_RE = re.compile(r"^verified:\s*$\n((?:^[ \t-].*$\n?)*)", re.MULTILINE)
_INLINE_VERIFIED_RE = re.compile(r"^verified:\s*(\{.*\}|\[.*\])\s*$", re.MULTILINE)
_BY_RE = re.compile(r"\bby:\s*[\"']?([^\"',}\s]+)")


def frontmatter(markdown: str) -> str:
    """Return the raw YAML frontmatter block, or an empty string."""
    match = re.match(r"^---\n(.*?)\n---", markdown, re.DOTALL)
    return match.group(1) if match else ""


def verifiers(markdown: str) -> list[str]:
    """Return the actors listed in the OKF ``verified`` field, in order."""
    front = frontmatter(markdown)
    block = _VERIFIED_BLOCK_RE.search(front)
    if block is not None:
        return _BY_RE.findall(block.group(1))
    inline = _INLINE_VERIFIED_RE.search(front)
    return _BY_RE.findall(inline.group(1)) if inline else []


def trust_tier(markdown: str) -> str:
    """Derive the SPEC §5.3 trust tier from a Gateway Answer document."""
    actors = verifiers(markdown)
    if not actors:
        return TRUST_UNVERIFIED
    if any(actor.startswith("human:") for actor in actors):
        return TRUST_HUMAN_REVIEWED
    return TRUST_MACHINE_CONFIRMED


def field(markdown: str, key: str) -> str | None:
    """Read one scalar frontmatter key (``request_id``, ``trace_id``, ...)."""
    pattern = rf"^{re.escape(key)}:\s*[\"']?([^\"'\n]+)"
    match = re.search(pattern, frontmatter(markdown), re.MULTILINE)
    return match.group(1).strip() if match else None


def client(gateway: str) -> httpx.Client:
    return httpx.Client(base_url=gateway.rstrip("/"), timeout=TIMEOUT_SECONDS)


def fail(message: str) -> int:
    print(f"error: {message}", file=sys.stderr)
    return 1


def describe_http_error(exc: httpx.HTTPStatusError) -> str:
    """Turn an error response into the gateway's own message where possible."""
    try:
        body: dict[str, Any] = exc.response.json()
    except ValueError:
        return f"{exc.response.status_code} {exc.response.text[:200]}"

    parts = [str(body.get("message") or body.get("error") or exc.response.status_code)]
    if body.get("categories"):
        parts.append(f"({', '.join(body['categories'])})")
    if body.get("request_id"):
        parts.append(f"[request_id={body['request_id']}]")
    return " ".join(parts)


def cmd_ask(args: argparse.Namespace) -> int:
    payload: dict[str, Any] = {"text": args.text}

    with client(args.gateway) as http:
        try:
            response = http.post("/v1/ask", json=payload)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            return fail(describe_http_error(exc))
        except httpx.HTTPError as exc:
            return fail(f"could not reach the gateway at {args.gateway}: {exc}")

    body = response.json()
    okf = body.get("okf", "")

    print("=== masked prompt (this is what the frontier model saw) ===")
    print(body.get("masked_prompt", ""))
    print()
    print("=== final answer (rehydrated for you) ===")
    print(body.get("answer", ""))
    print()

    attestation = body.get("attestation") or {}
    verdict = "pass" if attestation.get("ok") else "FAIL"
    print(f"trust tier : {trust_tier(okf)}")
    print(f"status     : {body.get('status')}")
    print(f"leak check : {verdict}", end="")
    if not attestation.get("ok"):
        print(f" — {attestation.get('reason')}", end="")
    print()

    findings = attestation.get("findings") or []
    if findings:
        print(f"findings   : {', '.join(findings)}")

    stats = body.get("stats") or {}
    if stats:
        counts = stats.get("counts_by_category") or {}
        summary = ", ".join(f"{key}x{value}" for key, value in sorted(counts.items()))
        print(f"masked     : {stats.get('masked_count')} span(s) {summary}".rstrip())

    withheld = attestation.get("withheld") or []
    if withheld:
        print(f"withheld   : {', '.join(withheld)} (left masked by the disclosure policy)")

    dimensions = body.get("dimensions") or {}
    if dimensions:
        print(
            "dimensions : "
            f"verdict={dimensions.get('policy_verdict')} "
            f"status={dimensions.get('document_status')} "
            f"freshness={dimensions.get('freshness')} "
            f"review={dimensions.get('review_identity')}"
        )

    print(f"request_id : {body.get('request_id')}")
    if body.get("trace_id"):
        print(f"trace_id   : {body['trace_id']}")

    # A failed attestation is surfaced, never dropped (OKF SPEC §10.5), and the
    # exit code carries it so a shell pipeline can react.
    return 0 if attestation.get("ok") else 2


def cmd_evidence(args: argparse.Namespace) -> int:
    """Fetch the stored masked OKF evidence document for one request."""
    with client(args.gateway) as http:
        try:
            response = http.get(f"/v1/requests/{args.request_id}")
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return fail(f"unknown request: {args.request_id}")
            return fail(describe_http_error(exc))
        except httpx.HTTPError as exc:
            return fail(f"could not reach the gateway at {args.gateway}: {exc}")

    markdown = response.text
    if args.json:
        print(
            json.dumps(
                {
                    "request_id": args.request_id,
                    "trust_tier": trust_tier(markdown),
                    "trace_id": field(markdown, "trace_id"),
                    "okf": markdown,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0

    print(markdown, end="" if markdown.endswith("\n") else "\n")
    print(f"\n-- trust tier: {trust_tier(markdown)}", file=sys.stderr)
    return 0


# --- replay ------------------------------------------------------------------

# The attester's patterns, transcribed. A replay that imported the fleet's own
# module would only prove the fleet agrees with itself; an independent
# transcription is what makes the check worth running.
_SCAN_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("EMAIL", re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
    ("AWS_KEY", re.compile(r"\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA)[0-9A-Z]{16}\b")),
    (
        "API_KEY",
        re.compile(
            r"\bsk-(?:[A-Za-z0-9]+-)?[A-Za-z0-9_-]{20,}\b"
            r"|\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b"
            r"|\bAIza[0-9A-Za-z_-]{35}\b"
        ),
    ),
    ("CREDIT_CARD", re.compile(r"\b(?:\d[ -]?){12,18}\d\b")),
    ("PHONE", re.compile(r"(?<![\d-])(?:\+81[ -]?|0)\d{1,4}[ -]?\d{1,4}[ -]?\d{3,4}(?![\d-])")),
    ("MY_NUMBER", re.compile(r"(?<![\d-])\d{12}(?![\d-])")),
    ("IPV4", re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")),
]


def _luhn_ok(digits: str) -> bool:
    if not digits.isdigit() or not 12 <= len(digits) <= 19:
        return False
    total = 0
    for index, char in enumerate(reversed(digits)):
        value = int(char)
        if index % 2 == 1:
            value *= 2
            if value > 9:
                value -= 9
        total += value
    return total % 10 == 0


def scan(text: str) -> list[str]:
    """Return the sorted set of PII categories in ``text``."""
    found: set[str] = set()
    for category, pattern in _SCAN_PATTERNS:
        for match in pattern.finditer(text):
            value = match.group(0)
            digits = re.sub(r"\D", "", value)
            if category == "CREDIT_CARD" and not _luhn_ok(digits):
                continue
            if category == "MY_NUMBER" and len(digits) != 12:
                continue
            if category == "IPV4":
                parts = value.split(".")
                if len(parts) != 4 or any(int(part) > 255 for part in parts):
                    continue
            found.add(category)
    return sorted(found)


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _attestation_block(markdown: str) -> dict[str, str]:
    """Read the flat scalars of the frontmatter ``attestation:`` block."""
    front = frontmatter(markdown)
    match = re.search(r"^attestation:\s*$\n((?:^[ \t]+.*$\n?)*)", front, re.MULTILINE)
    if match is None:
        return {}
    return {
        key: value.strip().strip("\"'")
        for key, value in re.findall(r"^\s+([a-z_]+):\s*(.+)$", match.group(1), re.MULTILINE)
    }


_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# The bundle files the `attestation` block names, relative to the repository
# root. A checkout is the third party's copy of the code that produced the
# verdict; hashing it here is what turns `attester_sha256` from a number the
# fleet asserts into one the reader confirms.
_BUNDLE_PATHS = {
    "attester_sha256": "knowledge/references/attesters/leak_check.ts",
    "computation_sha256": "knowledge/computations/leak-check.md",
}


def _repo_root() -> str:
    """The repository root, derived from this script's own location."""
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))


def _bundle_digest(relative: str) -> str | None:
    """SHA-256 of a bundle file, or ``None`` when the checkout is absent."""
    try:
        with open(os.path.join(_repo_root(), relative), "rb") as handle:
            return hashlib.sha256(handle.read()).hexdigest()
    except OSError:
        return None


def cmd_verify(args: argparse.Namespace) -> int:
    """Re-derive one answer's verdict from the artifacts the gateway serves.

    Every digest the document records is checked, not just the two artifact
    hashes: a replay that ignores ``attester_sha256`` and ``computation_sha256``
    cannot tell whether the verdict came from the code the document names.
    """
    base = args.base.rstrip("/")
    with httpx.Client(base_url=base, timeout=TIMEOUT_SECONDS) as http:
        try:
            okf = http.get(f"/v1/requests/{args.request_id}")
            okf.raise_for_status()
            prompt = http.get(f"/v1/requests/{args.request_id}/masked-prompt.md")
            prompt.raise_for_status()
            core = http.get(f"/v1/requests/{args.request_id}/core-response.md")
            core.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return fail(f"unknown request: {args.request_id}")
            return fail(describe_http_error(exc))
        except httpx.HTTPError as exc:
            return fail(f"could not reach the gateway at {base}: {exc}")

    recorded = _attestation_block(okf.text)
    if not recorded:
        return fail("the document carries no attestation block; nothing to replay")

    findings = scan(core.text)
    checks: list[tuple[str, bool, str]] = []

    # 1. Syntax. A digest that is not 64 lowercase hex characters names bytes
    #    nobody can fetch, so it is rejected before it is compared to anything.
    for name in (
        "masked_prompt_sha256",
        "core_response_sha256",
        "attester_sha256",
        "computation_sha256",
    ):
        value = recorded.get(name, "")
        checks.append(
            (f"{name} is a sha256 digest", bool(_SHA256_RE.match(value)), value or "(absent)")
        )

    # 2. The two artifacts the gateway serves, hashed here.
    checks.append(
        (
            "masked_prompt_sha256 matches the served prompt",
            recorded.get("masked_prompt_sha256") == sha256(prompt.text),
            recorded.get("masked_prompt_sha256", "(absent)"),
        )
    )
    checks.append(
        (
            "core_response_sha256 matches the served response",
            recorded.get("core_response_sha256") == sha256(core.text),
            recorded.get("core_response_sha256", "(absent)"),
        )
    )

    # 3. The attester and the computation, hashed from the bundle in this
    #    checkout. Skipped (and reported as skipped, never as a pass) when the
    #    script runs outside the repository.
    for name, relative in _BUNDLE_PATHS.items():
        local = _bundle_digest(relative)
        if local is None:
            print(f"SKIP {name} vs {relative}: bundle file not found in this checkout")
            continue
        checks.append(
            (
                f"{name} matches {relative}",
                recorded.get(name) == local,
                recorded.get(name, "(absent)"),
            )
        )

    # 4. The request id the document binds itself to, and the verdict.
    checks.append(
        (
            "request_id matches the document",
            recorded.get("request_id") == args.request_id,
            recorded.get("request_id", "(absent)"),
        )
    )
    checks.append(
        (
            "verdict matches the independently derived findings",
            recorded.get("verdict") == ("pass" if not findings else "fail"),
            recorded.get("verdict", "(absent)"),
        )
    )

    for name, ok, value in checks:
        print(f"{'OK  ' if ok else 'FAIL'} {name}: {value}")
    print(f"     independently derived findings: {', '.join(findings) or '(none)'}")
    print(f"     trust tier: {trust_tier(okf.text)}")

    return 0 if all(ok for _, ok, _ in checks) else 2


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="pgw",
        description="Language-agnostic client example for the Privacy-Preserving Gateway.",
    )
    parser.add_argument(
        "--gateway",
        default=DEFAULT_GATEWAY,
        help=f"gateway base URL (default: {DEFAULT_GATEWAY})",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    ask = sub.add_parser("ask", help="send a request across the trust boundary")
    ask.add_argument("text", help="the request, in the clear; it is masked before it leaves")
    ask.set_defaults(func=cmd_ask)

    evidence = sub.add_parser("evidence", help="fetch the stored masked OKF document")
    evidence.add_argument("request_id", help="the request id")
    evidence.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    evidence.set_defaults(func=cmd_evidence)

    verify = sub.add_parser("verify", help="replay one answer's attestation from the artifacts")
    verify.add_argument("request_id", help="the request id")
    verify.add_argument(
        "--base",
        default=DEFAULT_GATEWAY,
        help=f"gateway base URL (default: {DEFAULT_GATEWAY})",
    )
    verify.set_defaults(func=cmd_verify)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
