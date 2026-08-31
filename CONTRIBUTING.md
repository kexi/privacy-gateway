# Development

> 日本語版: [CONTRIBUTING.ja.md](CONTRIBUTING.ja.md)

The development environment is fully described by a **Nix flake devShell**.
Homebrew and per-language version managers are not used: every tool belongs in
`flake.nix`.

## 0. Prerequisites

- **Nix** — install it from the [official download page](https://nixos.org/download/)
  or with the [Determinate Systems installer](https://install.determinate.systems/),
  which enables flakes out of the box. With the official installer, enable flakes
  yourself by adding `experimental-features = nix-command flakes` to
  `~/.config/nix/nix.conf`.
- **direnv** (optional, recommended) — see the
  [installation guide](https://direnv.net/docs/installation.html), and remember
  to [hook it into your shell](https://direnv.net/docs/hook.html).

## 1. Entering the shell

### With direnv (recommended)

```sh
direnv allow
```

`direnv allow` is only needed once. After that the devShell activates whenever
you `cd` into the repository and deactivates when you leave.

`.envrc` does two things:

- `use flake` — loads `devShells.default` from `flake.nix`
- `dotenv_if_exists .env` — loads machine-local variables such as
  `GOOGLE_CLOUD_PROJECT`. `.env` is never committed.

### Without direnv

```sh
nix develop
```

For a one-off command:

```sh
nix develop -c just check
```

## 2. Git hooks install themselves

The devShell's `shellHook` runs `lefthook install`, so **the hooks are already
installed by the time you have a shell**. No manual setup step.

`lefthook install` only rewrites the hook stubs, so running it on every shell
entry is harmless. To reinstall explicitly:

```sh
just hooks
```

### What the hooks run

| Stage          | Checks                                                                                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pre-commit** | gitleaks (staged diff), ruff (standalone scripts), PEP 723 header check, oxlint / oxfmt --check / tsc --noEmit, just fmt-check, just check-recipe-docs, actionlint, pinact verify, terraform fmt/validate, tflint, nixfmt --check |
| **pre-push**   | `pnpm -r test` (vitest)                                                                                                                                                                                                           |

pre-commit is tuned for speed and scopes to **staged files** wherever possible.
Heavy work such as the full test suite runs on pre-push instead.

To run the hooks against every file:

```sh
just check-hooks
```

## 3. Running checks

`just` is the single entry point for every routine command:

```sh
just --list
```

The full CI-equivalent suite:

```sh
just check
```

Individual recipes:

```sh
just test               # vitest across the workspace (pnpm -r test)
just lint               # oxlint over the TypeScript workspace
just typecheck          # tsc --noEmit, per package
just fmt                # oxfmt + format every justfile
just fmt-check          # oxfmt --check + justfile formatting drift
just lint-python        # ruff over clients/ (standalone scripts)
just lint-pep723        # PEP 723 headers on standalone scripts
just check-recipe-docs  # fail on recipes without a doc comment
just lint-actions       # actionlint
just tf-fmt-check       # terraform fmt --check over infra/terraform
just tf-validate        # terraform validate (no backend, no credentials)
just tf-lint            # tflint over infra/terraform
just pin                # pin GitHub Actions to commit SHAs
just pin-verify         # verify pinned SHAs match version comments
just secrets-scan       # gitleaks (full history)
just fmt-nix            # format flake.nix
```

Deployment recipes live in `.just/deploy.just` and log/observability recipes in
`.just/logs.just`:

```sh
just urls               # Cloud Run service URLs
just health             # /healthz on every service
just logs-request <id>  # every log line for one request_id
just deploy             # deploy every service
```

Recipes are grouped into `.just/*.just` modules (`tooling`, `logs`, `deploy`)
and pulled into the root `justfile` with `import`.

**Every recipe needs a doc comment** — a `# ...` line directly above it.
`just check-recipe-docs` enforces this in pre-commit and CI, and `just fmt`
formats every justfile.

## 4. Adding packages

**Do not use Homebrew.** To add a development tool, edit `flake.nix`:

1. Add the package name to `devPackages`
2. Re-enter the shell (automatic with direnv, otherwise `nix develop`)

```nix
devPackages = with pkgs; [
  python313
  uv
  # add here
];
```

Search for package names with:

```sh
nix search nixpkgs <name>
```

To move nixpkgs forward, run the following and commit the `flake.lock` diff:

```sh
nix flake update
```

### Python is standalone scripts only

There is no Python project and no uv workspace: the services are TypeScript.
Python survives only as **standalone client scripts** (e.g.
`clients/python/pgw.py`), linted with `uvx ruff check clients/` against the root
`ruff.toml`. The devShell pins `UV_PYTHON` to the Nix interpreter and sets
`UV_PYTHON_DOWNLOADS=never`, so uv never fetches a different Python.

Such scripts must carry PEP 723 inline metadata so they run via `uv run`:

```python
# /// script
# requires-python = ">=3.13"
# dependencies = ["httpx"]
# ///
```

```sh
uv run clients/python/pgw.py
```

This keeps each script's dependencies self-contained and reproducible without
any project-level Python metadata. The `pep723-header` pre-commit hook catches a
missing header. Files that are part of a package (a sibling `__init__.py`
exists) are not standalone scripts and are exempt.

### Node / pnpm dependencies

Node is the primary runtime. Dependencies are managed by pnpm. The workspace is defined in the root
`pnpm-workspace.yaml` and the lockfile lives at the root, so install from there:

```sh
pnpm install
pnpm --filter web dev
```

**`minimumReleaseAge: 1440`** (24 hours) is configured — since pnpm 10 this
setting is read from `pnpm-workspace.yaml` rather than `.npmrc`.

This is a supply-chain guard. Compromised npm packages typically appear as a
malicious version published and then yanked within a few hours; refusing to
install anything younger than a day avoids that window. Dependabot is aligned
via `cooldown.default-days: 1`.

## 5. TypeScript lint and format (oxlint / oxfmt)

TypeScript is linted with **oxlint** (plus `oxlint-tsgolint` for type-aware
rules) and formatted with **oxfmt** — not eslint/prettier. Configuration lives at
the repo root in `.oxlintrc.json` and `.oxfmtrc.json`.

```sh
just lint         # oxlint
just fmt          # oxfmt, then format every justfile
just fmt-check    # oxfmt --check, then check every justfile
just typecheck    # tsc --noEmit, per package
```

**Type checking is a separate step.** oxlint does not replace `tsc`; `just
typecheck` runs `tsc --noEmit` in each package, and it takes optional package
names to narrow the run (`just typecheck @privacy-gateway/common`).

> **Why oxlint/oxfmt are not in the Nix devShell**
>
> Every other tool here comes from `flake.nix`, but these two are pnpm
> `devDependencies` instead. They lint the TypeScript sources, so their version
> has to match what CI and every editor integration resolves through the
> workspace — and that is decided by `pnpm-lock.yaml`, not by nixpkgs. Adding
> them to the devShell would create a second, independently-updated copy, and a
> devShell version drifting from the lockfile would produce lint results that
> differ between a local shell and CI. One pinned version in the workspace keeps
> that impossible.

## 6. End-to-end tests (Playwright)

E2E tests live in `web/` and run **chromium only**. The browser bundle comes
from Nix (`playwright-driver.browsers-chromium`), not from Playwright's own
downloader: the devShell exports `PLAYWRIGHT_BROWSERS_PATH` to point at the Nix
store, and `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` because the Nix store
does not carry the distro packages Playwright's host check looks for.

> **Pin `@playwright/test` in `web/package.json` to `1.61.1`.**
>
> Playwright refuses to launch a browser bundle whose version does not match the
> client library. The bundle is fixed by `flake.lock`, so the npm side must
> follow it. The devShell prints the current version on entry:
>
> ```
> playwright-driver 1.61.1 (pin @playwright/test to this version)
> ```
>
> After a `nix flake update`, re-read that line and update `package.json` to
> match if it changed.

E2E is deliberately **not** in the pre-commit or pre-push hooks — it is too slow
for a hook. It runs in the `node` CI job, which installs the browser with
`playwright install --with-deps chromium` (Playwright's own CLI, so the version
tracks the lockfile rather than a marketplace action).

## 7. Google Cloud

`google-cloud-sdk` is in the devShell, and authentication is shared with the
host environment:

```sh
gcloud auth login
gcloud auth application-default login
gcloud config set project <PROJECT_ID>
```

Put the project ID and similar values in `.env` for direnv to load. `.env` is
never committed.

`terraform` and `tflint` are in the devShell too. Cloud resources are declared in
`infra/terraform/` and are only ever created through the `just tf-*` recipes —
never by an ad-hoc `gcloud` command. The one exception is `just tf-bootstrap`,
which creates the GCS bucket holding Terraform's own remote state; that bucket
cannot be a Terraform resource because it has to exist before the first
`terraform init`.

`terraform fmt -check`, `terraform validate` and `tflint` run in pre-commit and
in the CI `terraform` job. `just tf-apply` and `just tf-destroy` always prompt
for interactive approval — they are never run with `-auto-approve`.

```sh
just tf-plan gpu_enabled=false   # what would change
just tf-validate                 # no backend, no credentials needed
```

## 8. Handling secrets

`gitleaks` runs in both pre-commit and CI.

Because this project has to prove its PII masking and leak checking actually
work, the test fixtures and `knowledge/` contain **intentional fake PII and fake
API keys**. `.gitleaks.toml` excludes those specific paths through a scoped
`allowlist` rather than disabling detection wholesale.

When new dummy secrets are needed, first try to place them under an existing
allowlisted path; only extend `.gitleaks.toml` if that is impossible, and always
with a comment explaining why.

## 9. CI

`.github/workflows/ci.yml` runs on push and pull request:

| Job         | Contents                                                                                                                  |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| `python`    | ruff check / format over `clients/`, PEP 723 headers                                                                      |
| `node`      | Only when `pnpm-lock.yaml` exists. pnpm install → oxlint → oxfmt --check → tsc → test → build → Playwright E2E (chromium) |
| `just`      | just fmt-just-check, check-recipe-docs, `just --list`                                                                     |
| `actions`   | actionlint, pinact verify                                                                                                 |
| `terraform` | terraform fmt -check, terraform validate, tflint over `infra/terraform`                                                   |
| `secrets`   | gitleaks (full history)                                                                                                   |
| `nix`       | `nix flake check`, devShell build                                                                                         |

The `just` job runs `fmt-just-check` rather than the full `fmt-check`: the other
formatters (nixfmt, oxfmt, ruff, terraform) are not installed on that runner and
are each covered by their own job. `just fmt-check` stays complete locally.

Every external action `uses:` is pinned to a full commit SHA, because tags are
mutable and leave the supply chain open to takeover. After adding an action or
letting dependabot bump one, re-pin:

```sh
just pin
just pin-verify
```

### Package-manager policy (moved from README)

Node.js 22 with a pnpm workspace. `pnpm-workspace.yaml` sets `minimumReleaseAge: 1440`, so a
package version published less than 24 hours ago is refused — a cooldown against compromised
releases. Postinstall scripts are blocked by default and `allowBuilds` re-enables only the
one that genuinely needs it (esbuild); a build script is arbitrary code execution at install
time, so the default answer is "no". pnpm itself is pinned via `packageManager` for corepack.
TypeScript lint and formatting are **oxlint** (1.79.0, with `oxlint-tsgolint` for type-aware
rules) and **oxfmt** (0.64.0) — not eslint/prettier — configured once at the repository root
in `.oxlintrc.json` and `.oxfmtrc.json`. Type checking stays a separate step (`just
typecheck`); oxlint does not replace `tsc --noEmit`.
Python survives only as standalone PEP 723 scripts (`clients/python/pgw.py`), run with
`uv run` and linted by **ruff** through a minimal root `ruff.toml`. There is no
`pyproject.toml`, no `uv.lock` and no `uv sync`: with no Python package to install, a
dependency-resolution step would only be lockfile ceremony around a script that declares its
own dependencies inline.
