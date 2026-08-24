{
  description = "privacy-gateway: Python 3.13 + uv monorepo on Google Cloud";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        # Terraform moved to the BSL in 1.6, so nixpkgs marks it unfree.
        # Why a predicate rather than `allowUnfree = true`: this permits exactly
        # one package, so an unfree dependency slipping in elsewhere still fails
        # the build instead of being silently accepted.
        # Why not opentofu (which is Apache-2.0 and would need no exception):
        # the google/google-beta providers are published and validated against
        # HashiCorp's registry first, and the Cloud Run v2 GPU attributes this
        # stack depends on land there earliest.
        pkgs = import nixpkgs {
          inherit system;
          config.allowUnfreePredicate = pkg: builtins.elem (nixpkgs.lib.getName pkg) [ "terraform" ];
        };

        # Playwright E2E (chromium only). The browser bundle is pinned by
        # nixpkgs, so @playwright/test in web/package.json MUST match
        # playwright-driver.version or Playwright refuses to launch.
        playwrightBrowsers = pkgs.playwright-driver.browsers-chromium;

        # Add google-cloud-sdk components as needed. gke-gcloud-auth-plugin is
        # deliberately left out: this stack targets Cloud Run, not GKE.
        gcloud = pkgs.google-cloud-sdk;

        devPackages = with pkgs; [
          python313
          uv
          just
          lefthook
          gitleaks
          pinact
          gh # pinact-verify needs an authenticated GitHub token (see lefthook.yml)
          actionlint
          ruff
          gcloud
          jq
          yq-go
          shellcheck
          nixfmt

          # Infrastructure is declared in Terraform under infra/terraform/.
          terraform
          tflint

          # Node is the primary runtime (pnpm workspace: web, packages/*,
          # agents/*). Why not corepack: pinning pnpm through nixpkgs keeps it
          # reproducible, and this version matches package.json's
          # packageManager field.
          nodejs_22
          pnpm
          playwrightBrowsers
        ];
      in
      {
        formatter = pkgs.nixfmt;

        devShells.default = pkgs.mkShell {
          packages = devPackages;

          # Python is only used for standalone PEP 723 client scripts run via
          # `uv run` / `uvx`. Point uv at the Nix interpreter so it never
          # downloads one of its own.
          env = {
            UV_PYTHON = "${pkgs.python313}/bin/python3.13";
            UV_PYTHON_DOWNLOADS = "never";

            # Point Playwright at the Nix-provided browsers instead of the ones
            # it would otherwise download into ~/.cache.
            PLAYWRIGHT_BROWSERS_PATH = "${playwrightBrowsers}";
            # The Nix store lacks the distro packages Playwright's host check
            # looks for, and that check would fail despite the browser working.
            PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS = "1";
          };

          shellHook = ''
            # `lefthook install` only rewrites the hook stubs, so it is idempotent
            # and safe to run on every shell entry. Skip it when there is no .git
            # (e.g. an extracted archive) since there is nothing to install into.
            if [ -d .git ] && command -v lefthook >/dev/null 2>&1; then
              lefthook install >/dev/null 2>&1 || true
            fi
            echo "devShell ready: run 'just --list' for commands / git hooks managed by lefthook"
            echo "playwright-driver ${pkgs.playwright-driver.version} (pin @playwright/test to this version)"
          '';
        };

        # Surface formatting violations through `nix flake check`.
        checks.nixfmt =
          pkgs.runCommand "check-nixfmt"
            {
              nativeBuildInputs = [ pkgs.nixfmt ];
            }
            ''
              nixfmt --check ${./flake.nix}
              touch $out
            '';
      }
    );
}
