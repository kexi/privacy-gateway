# 開発環境

> English version: [DEVELOPMENT.md](DEVELOPMENT.md)
> この文書は英語版の日本語訳です。内容が食い違う場合は英語版が正となります。

このリポジトリの開発環境は **Nix flake の devShell** で完結する。
Homebrew や各種バージョンマネージャは使わない。必要なツールはすべて `flake.nix` に書く。

## 1. シェルに入る

### direnv を使う（推奨）

```sh
direnv allow
```

初回だけ `direnv allow` が必要。以降はリポジトリに `cd` するだけで devShell が
自動で有効化され、離れると自動で解除される。

`.envrc` は次の 2 つを行う。

- `use flake` — `flake.nix` の `devShells.default` を読み込む
- `dotenv_if_exists .env` — ローカル専用の環境変数（`GOOGLE_CLOUD_PROJECT` など）を読む。
  `.env` はコミットしない

### direnv を使わない場合

```sh
nix develop
```

単発でコマンドを実行するだけなら次の形でよい。

```sh
nix develop -c just check
```

## 2. Git フックは自動で入る

devShell の `shellHook` が `lefthook install` を実行するため、
**シェルに入った時点で Git フックの導入は完了している**。手動セットアップは不要。

`lefthook install` は冪等（既存のフックを毎回書き直すだけ）なので、
シェルに入るたびに走っても問題ない。明示的に入れ直したいときは次を実行する。

```sh
just hooks
```

### フックの内容

| タイミング     | 内容                                                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pre-commit** | gitleaks（ステージ済み差分）、ruff（単体スクリプト）、PEP 723 ヘッダ検査、oxlint / oxfmt --check / tsc --noEmit、just fmt-check、just check-recipe-docs、actionlint、pinact verify、terraform fmt/validate、tflint、nixfmt --check |
| **pre-push**   | `pnpm -r test`（vitest）                                                                                                                                                                                                           |

pre-commit は速度を最優先し、可能な限り**ステージ済みファイルのみ**を対象にする。
テスト全体のような重い処理は pre-push に置いている。

フックを全ファイルに対して試したいときは次を実行する。

```sh
just check-hooks
```

## 3. 検査を走らせる

コマンドの入口はすべて `just` に集約している。一覧は次で確認する。

```sh
just --list
```

CI と同等の一通りの検査はこれ 1 つで走る。

```sh
just check
```

個別に走らせる主なレシピ。

```sh
just test               # workspace 全体の vitest（pnpm -r test）
just lint               # TypeScript workspace の oxlint
just typecheck          # パッケージごとの tsc --noEmit
just fmt                # oxfmt + すべての justfile を整形
just fmt-check          # oxfmt --check + justfile の整形崩れを検出
just lint-python        # clients/ の ruff（単体スクリプト）
just lint-pep723        # 単体スクリプトの PEP 723 ヘッダ検査
just check-recipe-docs  # doc コメントの無いレシピを検出
just lint-actions       # actionlint
just tf-fmt-check       # infra/terraform の terraform fmt --check
just tf-validate        # terraform validate（backend も認証情報も不要）
just tf-lint            # infra/terraform の tflint
just pin                # GitHub Actions を commit SHA に固定
just pin-verify         # 固定済み SHA とバージョンコメントの一致を検証
just secrets-scan       # gitleaks（全履歴）
just fmt-nix            # flake.nix の整形
```

デプロイ系は `.just/deploy.just`、ログ・可観測性系は `.just/logs.just` にある。

```sh
just urls               # Cloud Run のサービス URL 一覧
just health             # 各サービスの /healthz
just logs-request <id>  # ある request_id の全ログ
just deploy             # 全サービスをデプロイ
```

レシピは `.just/*.just` モジュール（`tooling` / `logs` / `deploy`）に分割し、
root の `justfile` から `import` している。

**すべてのレシピに doc コメント**（直上の `# ...` 行）が必要。
`just check-recipe-docs` が pre-commit と CI で強制し、`just fmt` が
すべての justfile を整形する。

## 4. パッケージを足す

**Homebrew は使わない。** 開発ツールの追加は `flake.nix` を編集する。

1. `flake.nix` の `devPackages` にパッケージ名を足す
2. シェルを入り直す（direnv なら自動、そうでなければ `nix develop`）

```nix
devPackages = with pkgs; [
  python313
  uv
  # ここに足す
];
```

パッケージ名は次で検索できる。

```sh
nix search nixpkgs <name>
```

nixpkgs 自体を新しくしたいときは次を実行し、`flake.lock` の差分をコミットする。

```sh
nix flake update
```

### Python は単体スクリプトのみ

Python プロジェクトも uv workspace も存在しない。サービスはすべて TypeScript で、
Python は **単体のクライアントスクリプト**（例: `clients/python/pgw.py`）としてのみ残る。
lint は root の `ruff.toml` を使って `uvx ruff check clients/` で行う。
devShell の Python は `UV_PYTHON` で Nix の python313 に固定してあり、
`UV_PYTHON_DOWNLOADS=never` により uv が勝手に別の Python を落としてくることはない。

これらのスクリプトは PEP 723 のインラインメタデータを書き、`uv run` で実行できる形にする。

```python
# /// script
# requires-python = ">=3.13"
# dependencies = ["httpx"]
# ///
```

```sh
uv run clients/python/pgw.py
```

こうしておくと、スクリプトごとの依存がファイル内で完結し、プロジェクト側に
Python のメタデータを持たせずに単体で再現実行できる。pre-commit の `pep723-header`
がヘッダの書き忘れを検出する。パッケージの一部（同じディレクトリに `__init__.py`
があるもの）は単体スクリプトではないので対象外。

### Node / pnpm の依存

Node が主たるランタイムで、依存は pnpm が管理する。pnpm workspace はリポジトリルートの
`pnpm-workspace.yaml` に定義され、lockfile もルートに置かれるため、
インストールはルートで行う。

```sh
pnpm install
pnpm --filter web dev
```

そのうえで **`minimumReleaseAge: 1440`（24 時間）** を設定してある
（pnpm 10 以降はこの設定を `.npmrc` ではなく `pnpm-workspace.yaml` で受け取る）。

これはサプライチェーン攻撃対策である。npm パッケージの乗っ取りは
「公開直後の悪性バージョン」として現れ、たいていは数時間以内に発見・削除される。
公開から 24 時間経過したバージョンしかインストールしないことで、その窓を避ける。
dependabot 側も `cooldown.default-days: 1` で揃えてある。

## 5. TypeScript の lint と整形（oxlint / oxfmt）

TypeScript の lint は **oxlint**（型を見るルール用に `oxlint-tsgolint` を併用）、
整形は **oxfmt** で行う。eslint / prettier は使わない。設定はリポジトリルートの
`.oxlintrc.json` と `.oxfmtrc.json` に置く。

```sh
just lint         # oxlint
just fmt          # oxfmt の後に全 justfile を整形
just fmt-check    # oxfmt --check の後に全 justfile を検査
just typecheck    # パッケージごとの tsc --noEmit
```

**型検査は独立した工程である。** oxlint は `tsc` を置き換えない。`just typecheck`
が各パッケージで `tsc --noEmit` を実行する。対象を絞りたい場合はパッケージ名を
渡せる（`just typecheck @privacy-gateway/common`）。

> **なぜ oxlint / oxfmt を Nix devShell に入れないのか**
>
> 他のツールはすべて `flake.nix` から供給しているが、この 2 つだけは pnpm の
> `devDependencies` に置く。これらは TypeScript のソースを検査するツールなので、
> バージョンは CI やエディタ統合が workspace 経由で解決するものと一致していな
> ければならず、それを決めるのは nixpkgs ではなく `pnpm-lock.yaml` である。
> devShell にも入れると独立に更新される 2 つ目の実体ができてしまい、devShell 側
> が lockfile とずれた瞬間、ローカルと CI で lint 結果が食い違う。workspace に
> 固定した 1 つのバージョンだけを使えば、その事故は原理的に起こらない。

## 6. E2E テスト（Playwright）

E2E テストは `web/` にあり、**chromium のみ**で動かす。ブラウザ本体は Playwright の
ダウンローダではなく Nix（`playwright-driver.browsers-chromium`）から供給する。
devShell が `PLAYWRIGHT_BROWSERS_PATH` を Nix store に向けて export し、
あわせて `PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1` を設定する
（Nix store には Playwright のホスト検査が探すディストリのパッケージが無いため）。

> **`web/package.json` の `@playwright/test` は `1.61.1` に固定すること。**
>
> Playwright はクライアントライブラリとバージョンの合わないブラウザバンドルを
> 起動しない。バンドル側は `flake.lock` で固定されているので、npm 側がそれに
> 合わせる必要がある。devShell は入室時に現在のバージョンを表示する。
>
> ```
> playwright-driver 1.61.1 (pin @playwright/test to this version)
> ```
>
> `nix flake update` の後はこの行を読み直し、変わっていれば `package.json` を
> 合わせて更新する。

E2E は遅いため pre-commit にも pre-push にも**意図的に入れていない**。CI の
`node` ジョブでのみ実行し、ブラウザは `playwright install --with-deps chromium`
（Playwright 自身の CLI。マーケットプレイスの Action は使わないので、バージョンは
lockfile に追従する）で入れる。

## 7. Google Cloud

`google-cloud-sdk` は devShell に入っている。認証はシェルの外と共有される。

```sh
gcloud auth login
gcloud auth application-default login
gcloud config set project <PROJECT_ID>
```

プロジェクト ID などは `.env` に書いておくと `direnv` が読み込む。
`.env` はコミットしない。

`terraform` と `tflint` も devShell に入っている。クラウド上のリソースは
`infra/terraform/` で宣言し、作成は必ず `just tf-*` レシピ経由で行う。
その場限りの `gcloud` コマンドで作ってはいけない。唯一の例外が `just tf-bootstrap` で、
これは Terraform 自身の remote state を置く GCS バケットを作る。最初の
`terraform init` より前に存在している必要があるため、Terraform のリソースにはできない。

`terraform fmt -check` / `terraform validate` / `tflint` は pre-commit と CI の
`terraform` ジョブの両方で走る。`just tf-apply` と `just tf-destroy` は常に対話的な
承認を求める（`-auto-approve` は使わない）。

```sh
just tf-plan gpu_enabled=false   # 変更内容の確認
just tf-validate                 # backend も認証情報も不要
```

## 8. シークレットの扱い

`gitleaks` が pre-commit と CI の両方で走る。

本プロジェクトは PII マスクとリーク検査の正しさを検証する都合上、
テストフィクスチャと `knowledge/` 配下に**意図的な偽 PII / 偽 API キー**を置いている。
これらは `.gitleaks.toml` の `allowlist` で対象パスを絞って除外している
（全体を無効化はしていない）。

新しく偽の秘密情報を置く必要が出たら、まず既存の allowlist 対象パスに置けないかを
検討し、どうしても必要なら `.gitleaks.toml` に理由コメント付きで追記する。

## 9. CI

`.github/workflows/ci.yml` が push と PR で走る。ジョブは次の通り。

| ジョブ      | 内容                                                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------------------------------------ |
| `python`    | `clients/` の ruff check / format、PEP 723 ヘッダ検査                                                                    |
| `node`      | `pnpm-lock.yaml` がある場合のみ。pnpm install → oxlint → oxfmt --check → tsc → test → build → Playwright E2E（chromium） |
| `just`      | just fmt-check、check-recipe-docs、`just --list`                                                                         |
| `actions`   | actionlint、pinact verify                                                                                                |
| `terraform` | `infra/terraform` の terraform fmt -check、terraform validate、tflint                                                    |
| `secrets`   | gitleaks（全履歴）                                                                                                       |
| `nix`       | `nix flake check`、devShell のビルド確認                                                                                 |

外部 Action の `uses:` はすべて完全な commit SHA に固定してある
（タグは書き換え可能なので、SHA でなければ供給元の乗っ取りに対して無防備になる）。
Action を足したり dependabot が更新したりしたあとは、次を実行して再固定する。

```sh
just pin
just pin-verify
```
