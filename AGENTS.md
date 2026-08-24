# AGENTS.md

Instructions for AI coding agents (Codex, Claude Code, others) working in this repository.
`CLAUDE.md` includes this file; keep project-wide rules here, not there.

## Project

Privacy-preserving multi-agent gateway for the All Things Agentic Hackathon (Devpost).
Deadline: **2026-08-31 17:00 PDT**. Category: Fortified Enterprise Fleet.
Design of record: `docs/ARCHITECTURE.md`. Deployment runbook: `docs/DEPLOY.md`. Dev setup: `docs/DEVELOPMENT.md`.

- All three agents are **ADK TypeScript** (`@google/adk` 2.x): Gateway (Gemma via `OllamaLlm`) → **A2A** → Core (Gemini 3.5 on Vertex AI, `gemini-3.5-flash`) → **authenticated HTTP** → Synthesis (Gemma). Only the Gateway → Core hop uses A2A; Synthesis is reached over HTTP on purpose, because the OKF document is an audit artifact and must be retrieved without an LLM rephrasing it. Do not claim the fleet is all-A2A. A single-file Python client (`clients/python/pgw.py`, PEP 723) demonstrates language-agnostic consumption.
- Token Vault: Firestore, **one entry per request** keyed by a server-generated UUIDv7. There are no sessions and no caller-supplied ids: a caller who can name a vault key can make the fleet resolve someone else's placeholders. Core has **no** Firestore access — enforced by IAM (Core's service account holds no Firestore role), not by the package graph; never grant it.
- Every final answer is an **OKF v0.2** document (`type: Gateway Answer`) whose body holds the **masked** answer. See `skills/okf/`. `generated.by` is the Synthesis agent, the Core invocation is provenance in `sources[]`, and `verified[].by` is `process:leak-check@<digest>` — never an LLM actor, because TypeScript regex code decides the verdict.
- The masking is **pseudonymization, not anonymization**: placeholders disclose category and equality, and surviving quasi-identifiers permit contextual re-identification. Say so; do not overclaim.
- Human review is **out of scope**: the public gateway authenticates nobody, so nothing can name a reviewer. Never mint a `human:` OKF actor in this product.
- Google Cloud project: `all-thinkgs`, region `us-central1` (Cloud Run GPU availability).

## Language policy

- **English is primary. Japanese is secondary. Both must exist.**
  `README.md` + `README.ja.md`, `docs/X.md` + `docs/X.ja.md`. When you change one, update the other.
- Code comments, docstrings, log messages, commit messages, CI output: English.
- Conversation with the maintainer may be in Japanese.

## Writing conventions

- Code explains **How**. Tests state **What** is guaranteed. Commit messages give **Why**. Code comments give **Why not** (alternatives rejected).
- Never log or persist raw PII. Persist only masked artifacts keyed by `request_id`; the rehydrated answer is returned in one API response and never stored.
- **Fail closed.** Every safety gate that cannot produce a trustworthy result refuses the request rather than degrading. There is deliberately no path that sends or releases "anyway" — see `docs/ARCHITECTURE.md` for the gate list and status codes.

## Toolchain

- Enter the environment with `direnv allow` or `nix develop` (Nix flake; packages are managed in `flake.nix`, never Homebrew). The devShell installs lefthook pre-commit hooks automatically.
- `just` is the **only** command surface. Docs and skills reference `just <recipe>`, never raw `gcloud`/`pnpm`/`docker` invocations (put the raw command inside a recipe). Recipes are grouped in `.just/*.just` modules imported from the root `justfile`.
- **Every recipe must have a doc comment** (`# ...` line directly above it). `just fmt` formats justfiles; `just fmt-check` and the recipe-doc check run in lefthook and CI and fail on undocumented recipes.
- Node.js 22 + TypeScript + **pnpm workspace** (`web`, `packages/common`, `agents/core`, `agents/gateway`, `agents/synthesis`).
- Python is used only for standalone scripts (e.g. `clients/python/pgw.py`). They must carry **PEP 723** inline metadata, run via `uv run path/to/script.py`, and pass **ruff** (`ruff.toml` at root). `minimumReleaseAge=1440`: packages published less than 24h ago are refused (supply-chain safety). Do not switch to bun/npm/yarn.
- TypeScript lint/format: **oxlint** (with `oxlint-tsgolint` for type-aware rules) and **oxfmt** — not eslint/prettier. Config at repo root (`.oxlintrc.json`, `.oxfmtrc.json`); one `pnpm` devDependency version for the whole workspace.
- **Type checking is a separate step**: `tsc --noEmit` per package (`just typecheck`). oxlint does not replace it.
- **Workspace packages type-resolve to source**: each package's `exports` maps `types` to `./src/*.ts` (not `./dist/*.d.ts`), alongside `development` for bundlers and `default` for the built `dist/*.js`. Why not `dist/*.d.ts`: it makes `tsc --noEmit` depend on a prior `pnpm -r build`, so a clean checkout fails to typecheck. Node ignores `types`, so runtime still loads `dist/`.
- **Import specifiers use the `.ts` extension** (`import { x } from './x.ts'`): `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` in tsconfig; tsc rewrites to `.js` on build. Never write `.js` in source imports.
- Pre-commit (lefthook): gitleaks, oxlint, oxfmt --check, tsc --noEmit, actionlint, pinact verify, terraform fmt/validate, tflint, nix fmt, just fmt-check, recipe-doc check, ruff (clients/). Pre-push: `pnpm -r test`.
- GitHub Actions refs are pinned to commit SHAs with **pinact**; run `just pin` after editing workflows.
- Secrets: never commit real credentials. Test fixtures with fake PII/keys are allow-listed in `.gitleaks.toml`.

## Testing

- Unit/integration: **vitest** in every package (`pnpm -r test`). Tests state _what_ is guaranteed.
- Browser E2E: **Playwright** (chromium) in `web/e2e`, run via `just web-e2e`; not in pre-commit/pre-push, runs in CI. Mock Core/Ollama over HTTP; never hit real Gemini/Gemma in tests.

## Infrastructure

- Google Cloud resources are declared in **Terraform** under `infra/terraform/` (google provider, Cloud Run v2, IAM, Firestore + TTL, Artifact Registry). Never create cloud resources with ad-hoc `gcloud` commands; put them in Terraform. Container images are built by Cloud Build via `just build`.
- Run only through `just tf-*` recipes (`tf-init`, `tf-plan`, `tf-apply`, `tf-destroy`). `terraform fmt -check`, `terraform validate` and `tflint` run in lefthook and CI. `tf-apply`/`tf-destroy` are never run by agents without explicit maintainer approval.
- Remote state lives in a GCS bucket; secrets never go into `.tfvars` committed to git.

## Runtime conventions

- **zod at every boundary**: HTTP request/response, A2A payloads, LLM JSON outputs, env config (fail fast at startup), OKF frontmatter. Shared schemas live in `packages/common`; `web` derives its types from them.
- **Structured logs**: one JSON object per line, Cloud Logging compatible (`severity`, `message`, `time`, `event`, `agent`, `request_id`, `duration_ms`, `logging.googleapis.com/trace`, `logging.googleapis.com/spanId`). Fields pass a **typed allowlist** in `packages/common/src/logging.ts` — an unlisted field is dropped, not masked, and its key name is recorded under `dropped_fields`. Adding a log field means adding it to that allowlist. Never log an exception message: `error_class` and `error_code` only, in logs and in spans alike.
- **Request ID propagation**: the Gateway mints a UUIDv7 per request and **never adopts the inbound `X-Request-ID`** — the id is the vault key. It flows Gateway → Core → Synthesis via headers and A2A metadata, is echoed in responses, and is stored in the OKF `Gateway Answer` as `request_id` / `trace_id`.
- **Distributed tracing**: OpenTelemetry with W3C `traceparent` propagated across every hop; one request = one Cloud Trace trace with parent/child spans per agent step. Logs carry `trace_id`/`span_id` so Cloud Logging and Cloud Trace cross-link. Span attributes never contain PII values. See `docs/OBSERVABILITY.md`.

## Skills

- `okf` — read before touching knowledge docs, audit records, Synthesis output schema, or anything with `sources/generated/verified/status/stale_after`. Shared body: `skills/okf/OKF.md`; wrappers in `.claude/skills/okf` and `.codex/skills/okf`.
- `pgw-logs` — where logs/traces/audit records live and how to query them (`skills/pgw-logs/LOGS.md`). Use for any debugging by request_id / trace_id.
- New skills follow the same layout: shared body under `skills/<name>/`, thin `SKILL.md` wrappers for both Claude Code and Codex.

## Git

- Do not commit or push unless the maintainer asks. Work on `main` only when told.
- Conventional, English commit messages that explain **why**.

## Model roles (Claude Code)

Fable orchestrates and designs; Opus implements; Sonnet for sub-delegation; Haiku for light read-only tasks.
