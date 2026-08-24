# /// script
# requires-python = ">=3.13"
# dependencies = ["httpx"]
# ///
"""Command-line client for the Privacy-Preserving Gateway.

A deliberately small, dependency-light example: the gateway speaks ordinary
JSON over HTTP, so consuming the fleet needs no SDK and no shared runtime with
the agents. This file exists to demonstrate exactly that.

Usage:
    uv run clients/python/pgw.py ask "text" [--gateway URL] [--session ID]
    uv run clients/python/pgw.py answer <session> [--gateway URL]
    uv run clients/python/pgw.py approve <session> --by human:<id> [--gateway URL]

The trust tier is derived here, on the client, from the OKF ``verified`` field
rather than read from the server's response: OKF SPEC §5.3 requires the tier to
be derived and never stored, and a client that re-derives it proves the property
holds end to end.
"""

from __future__ import annotations

import argparse
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
    if args.session:
        payload["session_id"] = args.session

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

    print(f"session    : {body.get('session_id')}")
    print(f"request_id : {body.get('request_id')}")
    if body.get("trace_id"):
        print(f"trace_id   : {body['trace_id']}")

    # A failed attestation is surfaced, never dropped (OKF SPEC §10.5), and the
    # exit code carries it so a shell pipeline can react.
    return 0 if attestation.get("ok") else 2


def cmd_answer(args: argparse.Namespace) -> int:
    with client(args.gateway) as http:
        try:
            response = http.get(f"/v1/sessions/{args.session}/answer")
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return fail(f"unknown session: {args.session}")
            return fail(describe_http_error(exc))
        except httpx.HTTPError as exc:
            return fail(f"could not reach the gateway at {args.gateway}: {exc}")

    markdown = response.text
    if args.json:
        print(
            json.dumps(
                {
                    "session_id": args.session,
                    "trust_tier": trust_tier(markdown),
                    "request_id": field(markdown, "request_id"),
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


def cmd_approve(args: argparse.Namespace) -> int:
    # SPEC §7: a human actor is `human:<id>`; the prefix is what the tier
    # derivation keys on, so it is normalized before sending.
    approver = args.by if args.by.startswith("human:") else f"human:{args.by}"

    with client(args.gateway) as http:
        try:
            response = http.post(
                f"/v1/sessions/{args.session}/approve",
                json={"approver": approver},
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                return fail(f"unknown session: {args.session}")
            return fail(describe_http_error(exc))
        except httpx.HTTPError as exc:
            return fail(f"could not reach the gateway at {args.gateway}: {exc}")

    body = response.json()
    markdown = body.get("markdown", "")
    print(f"approved by {approver}")
    print(f"trust tier : {trust_tier(markdown)}")
    return 0


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
    ask.add_argument("--session", help="reuse a session so placeholders stay stable")
    ask.set_defaults(func=cmd_ask)

    answer = sub.add_parser("answer", help="fetch the stored OKF answer document")
    answer.add_argument("session", help="the session id")
    answer.add_argument("--json", action="store_true", help="emit JSON instead of markdown")
    answer.set_defaults(func=cmd_answer)

    approve = sub.add_parser("approve", help="add a human approval to the answer")
    approve.add_argument("session", help="the session id")
    approve.add_argument("--by", required=True, help="approver id, e.g. human:kei")
    approve.set_defaults(func=cmd_approve)

    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args))


if __name__ == "__main__":
    raise SystemExit(main())
