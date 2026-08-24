# デプロイ Runbook

対象プロジェクト: `all-thinkgs`（プロジェクト番号 `257034533412`） / リージョン: **`us-central1`** /
アカウント: `kei.of.nakayama@gmail.com`

このドキュメントは `infra/terraform/` と `serving/` の運用手順。アーキテクチャの意図は
[ARCHITECTURE.md](./ARCHITECTURE.md)、構成図は [diagram/architecture.drawio.png](./diagram/architecture.drawio.png)。

クラウドリソースはすべて `infra/terraform/` 配下の Terraform で宣言し、`just tf-*` レシピ経由で
適用する。唯一の例外は Terraform の state を置く GCS バケットで、これは `terraform init` より
先に存在している必要があるため `just tf-bootstrap` が gcloud で作る。コンテナイメージは
`just build` が別途ビルドする（イメージタグはインフラではなく成果物なので）。

---

## 1. リージョン選定: なぜ `us-central1` か

**結論: 全リソース (Cloud Run 4 サービス + Firestore + Vertex AI) を `us-central1` に統一する。**

当初は `asia-northeast1` (東京) を第一候補としたが、**Cloud Run GPU が東京では使えない**ため却下した。
2026-08 時点で Cloud Run の NVIDIA L4 が使えるリージョンは以下に限られる。

| リージョン                    | L4    | 価格 Tier |
| ----------------------------- | ----- | --------- |
| `us-central1` (Iowa)          | ○     | Tier 1    |
| `us-east4` (N. Virginia)      | ○     | Tier 2    |
| `europe-west1` (Belgium)      | ○     | Tier 1    |
| `europe-west4` (Netherlands)  | ○     | Tier 1    |
| `asia-southeast1` (Singapore) | ○     | Tier 2    |
| `asia-northeast1` (Tokyo)     | **×** | Tier 1    |

注意: `gcloud compute accelerator-types list` は東京にも `nvidia-l4` を返すが、これは
**Compute Engine** の話であって Cloud Run の GPU 対応リージョンとは別リスト。混同しないこと。

`us-central1` を選ぶ理由:

1. **Cloud Run GPU が使える**（必須条件。ここで候補が 5 つに絞られる）
2. **Tier 1 価格**（`us-east4` / `asia-southeast1` は Tier 2 で CPU/メモリ単価が高い）
3. **GPU quota が最も通りやすい**（L4 の在庫が最大のリージョン）
4. **Firestore と Vertex AI Gemini が同居できる**ので、A2A ホップと Vault アクセスが
   すべてリージョン内で完結する。クロスリージョンのレイテンシと下り課金が乗らない
5. Vertex AI の Gemini モデルが最も早く出揃うリージョンでもある

トレードオフ: 日本からのデモだと往復レイテンシが約 100〜150ms 乗る。ただし本システムの
支配項は Gemma 推論と Gemini 推論（秒オーダー）なので、体感への影響は小さい。
**GPU が使えないリージョンを選ぶ選択肢は存在しない**ため、これは受け入れる。

変更したい場合は環境変数（`REGION=europe-west1 just deploy`）か、Terraform 変数の直接指定
（`just tf-apply region=europe-west1`）で上書きできる。

---

## 2. 前提

```bash
gcloud config set project all-thinkgs
gcloud config set account kei.of.nakayama@gmail.com
gcloud auth login
gcloud auth application-default login   # Terraform とローカル開発用
```

`terraform` と `tflint` は Nix devShell に入っているので、`nix develop`（または direnv）だけで
正しいバージョンが揃う。Terraform は Application Default Credentials で認証するため、上の
`application-default login` はローカル開発用ではなく**必須**。

必要な IAM（実行者本人）: `roles/owner` もしくは
`run.admin` + `iam.serviceAccountAdmin` + `datastore.owner` + `artifactregistry.admin` +
`cloudbuild.builds.editor` + `serviceusage.serviceUsageAdmin` + `storage.admin`
（最後のひとつは Terraform state バケット用）。

---

## 3. 手順

Terraform は宣言的で、レシピは**冪等**。途中で失敗しても、原因を直して同じコマンドを
再実行してよい。Terraform はその時点の state から差分を収束させる。

§3.5 の GPU quota ゲートを含めた全体の順序:

```
just tf-bootstrap                 # プロジェクトにつき 1 回
just tf-init                      # チェックアウトにつき 1 回
just build                        # Gemma で約 25 分（まっさらなプロジェクトでの
                                  #   初回だけは §3.3 の注記を参照）
just tf-plan gpu_enabled=false    # 確認: 33 リソース追加
just tf-apply gpu_enabled=false   # gemma-serving 以外すべて
   ... L4 quota の承認を待つ（§6）...
just tf-apply                     # gemma-serving を追加、計 36
just urls && just health          # 検証（§8）
just tf-destroy                   # 終わったら（§10）
```

### 3.0 設定の確認

既定値は `infra/terraform/variables.tf`、上書きする価値のある値は
`infra/terraform/example.tfvars` に例がある。上書きは `var=value` 形式で呼び出しごとに渡す:

```bash
just tf-plan gemma_model=gemma3:4b
just tf-apply gpu_enabled=false
```

環境変数 `PROJECT_ID` / `REGION` / `IMAGE_TAG` / `GEMMA_MODEL` / `TF_STATE_BUCKET` も従来通り
有効で、レシピ側が読む:

```bash
GEMMA_MODEL=gemma3:4b just build gemma
```

### 3.1 Terraform state バケットの bootstrap

```bash
just tf-bootstrap
```

デプロイ先リージョンに `gs://all-thinkgs-tfstate`（`TF_STATE_BUCKET` で上書き可）を、
uniform bucket-level access・public access prevention・**バージョニング有効**で作る。
バージョニングがあるので、state ファイルが壊れたり切り詰められたりしても巻き戻せる。
レシピは冪等で、2 回目以降は `already exists` と出るだけ。

これがリポジトリ内で **Terraform ではなく gcloud が作る唯一のリソース**。理由は
鶏と卵で、`terraform init` が state を置く前にバケットが存在していなければならないため、
バケット自体を Terraform リソースにはできない。

### 3.2 Terraform の初期化

```bash
just tf-init
```

`-backend-config=bucket=all-thinkgs-tfstate` を渡して GCS バックエンドに対し
`terraform init` を実行する。バケット名を `backend.tf` に書かないのは意図的で、
コミット対象の設定から外しておくことで、別環境が同じディレクトリをそのまま再利用できる。
state は prefix `agentic-fleet` の下に置かれる。

`TF_STATE_BUCKET` を変えたときや、provider のバージョンを上げたとき
（`just tf-init -upgrade`）は再実行する。

### 3.3 イメージのビルド

```bash
just build                    # 4 つ全部
just build gemma              # Gemma だけ
just build core gateway       # 一部だけ
```

Cloud Build が Artifact Registry の `agentic-fleet` リポジトリへ push する。イメージを
Terraform の外に置いているのは意図的で、plan のたびに再ビルドするのは耐えられないし、
タグはインフラではなく成果物だから。Terraform は `image_tag` 変数（既定 `latest`）
としてタグを受け取る。

Gemma イメージは**モデルをビルド時に焼き込む**ため時間がかかる（`gemma3:12b` で 15〜25 分）。
`e2-highcpu-32` / disk 100GB / timeout 3600s で回す。ここを毎回やり直さないよう、
Gemma のビルドは一度成功したらタグを固定しておくとよい。

> Artifact Registry リポジトリ自体が Terraform リソースなので、まっさらなプロジェクトでの
> 初回だけは `just build` を最初の `just tf-apply` の**後**に実行する必要がある（そうでないと
> push 先が存在しない）。実際の手順としては、まず `gpu_enabled=false` で apply し（イメージの
> pull には失敗する）、`just build` してからもう一度 apply する。2 周目以降はリポジトリが
> 既にあるので `just build` が先でよい。

### 3.4 plan と apply

```bash
just tf-plan                  # 変更内容の確認
just tf-apply                 # 対話的な承認つきで適用
```

`just tf-apply` は意図的に `-auto-approve` を**渡さない**。GPU 課金の走るリソースを作るので、
毎回人間が plan を読む。`just deploy` は `just build` → `just tf-apply` のショートハンドで、
同じ `var=value` の上書きを受け付ける。

クリーンな apply が作るもの:

| リソース種別                             | `gpu_enabled=true` | `gpu_enabled=false` |
| ---------------------------------------- | ------------------ | ------------------- |
| `google_project_iam_member`              | 11                 | 11                  |
| `google_project_service`                 | 9                  | 9                   |
| `google_cloud_run_v2_service_iam_member` | 5                  | 3                   |
| `google_service_account`                 | 4                  | 4                   |
| `google_cloud_run_v2_service`            | 4                  | 3                   |
| `google_firestore_field`（TTL）          | 1                  | 1                   |
| `google_firestore_database`              | 1                  | 1                   |
| `google_artifact_registry_repository`    | 1                  | 1                   |
| **合計**                                 | **36**             | **33**              |

`google_project_service` が有効化する API: `run` / `compute` / `artifactregistry` /
`cloudbuild` / `firestore` / `aiplatform` / `iam` / `logging` / `cloudtrace`。
`compute.googleapis.com` が要るのは、Direct VPC egress で `default` VPC を参照するため
（§3.7 参照）。これが無いとサブネットの解決に失敗する。`disable_on_destroy = false` を
付けているので `just tf-destroy` しても有効なまま残る。API を無効化すると、プロジェクト内の
無関係なワークロードまで巻き添えで落ちるため。

Firestore: `us-central1` に Native モードの `(default)` DB と、`token_vault` コレクションの
`expires_at` フィールドの TTL ポリシー。

TTL の注意点:

- TTL フィールドは **timestamp 型**であること
- ポリシー有効化に **10 分以上**かかる
- 実削除は期限到来から **24 時間以内**（即時ではない）
- **したがって読み出し側（Synthesis）は `expires_at` を必ず自前でも検証すること。**
  TTL は容量管理であって、アクセス制御ではない

### 3.5 GPU quota 待ちのあいだのデプロイ

`gpu_enabled=false` は `gemma-serving` サービスと、それを指す 2 本の `run.invoker` バインディングを
スキップする。残る 33 リソースは GPU quota を一切必要としない。**まっさらなプロジェクトでは
これが推奨経路**で、L4 quota の申請（§6）は数分〜数日かかる一方、その間に他は全部立てて
検証まで済ませられる。

```bash
just tf-plan gpu_enabled=false     # 追加 33
just tf-apply gpu_enabled=false
```

quota が `grantedValue: 1` になったら戻す:

```bash
just tf-apply                      # gpu_enabled の既定は true。3 リソース追加
```

2 回目の apply が追加するのは `gemma-serving` と invoker 2 本だけ。エージェント 3 サービスは
**作り直されない**。1 回目の apply で渡した Gemma の URL は、サービスから読み戻したものではなく
事前計算した値（§3.6）なので、サービスが存在しない時点で既に正しかったから。

### 3.6 Cloud Run の決定的 URL

Cloud Run は、DNS ラベル（サービス名 + プロジェクト番号 + タグ）が 63 文字以内である限り、
必ず次の形式の URL を割り当てる。

```
https://<service>-<project_number>.<region>.run.app
```

本プロジェクトで最長なのは `synthesis-agent`（15）+ `-` + 12 桁のプロジェクト番号
`257034533412` = 28 文字で、上限には余裕がある。
[cloud.google.com/run/docs/triggering/https-request](https://cloud.google.com/run/docs/triggering/https-request)
で確認済み。

したがって URL は何も作る前から確定している。

| サービス          | URL                                                        |
| ----------------- | ---------------------------------------------------------- |
| `gateway-agent`   | `https://gateway-agent-257034533412.us-central1.run.app`   |
| `core-agent`      | `https://core-agent-257034533412.us-central1.run.app`      |
| `synthesis-agent` | `https://synthesis-agent-257034533412.us-central1.run.app` |
| `gemma-serving`   | `https://gemma-serving-257034533412.us-central1.run.app`   |

**これが「1 回の apply で全部立つ」理由。** 置き換え前のシェル版は、各サービスを作って
`status.url` を読み戻し、`gcloud run services update` をもう一度走らせて `A2A_PUBLIC_URL` と
下流のベース URL を注入する必要があった（`gemma → core → synthesis → gateway` の順序制約 +
2 フェーズのパッチ）。プロジェクト番号から URL を算出することで、これが 1 回の apply に潰れ、
サービス間の依存サイクルそのものが消える。Terraform は 4 つを並列に作る。

`GEMMA_BASE_URL` は OpenAI 互換の `/v1` パスまで含める
（`https://gemma-serving-257034533412.us-central1.run.app/v1`）。
`packages/common/src/config.ts` がこの形で検証する。`CORE_BASE_URL` と `SYNTHESIS_BASE_URL` は
パス無しのベース URL。

`just tf-output deterministic_urls` が事前計算値を、`gateway_url` / `core_url` /
`synthesis_url` の各 output が Cloud Run が実際に割り当てた値を出すので、両者の食い違いは
すぐ見える。

公開範囲:

| サービス          | 認証                          | ingress      | 備考                           |
| ----------------- | ----------------------------- | ------------ | ------------------------------ |
| `gateway-agent`   | `allUsers` に `run.invoker`   | all          | 唯一の公開入口。デモ UI もここ |
| `core-agent`      | IAM（gateway SA のみ）        | all          | gateway の ID token のみ       |
| `synthesis-agent` | IAM（gateway SA のみ）        | all          | gateway の ID token のみ       |
| `gemma-serving`   | IAM（gateway / synthesis SA） | **internal** | 境界内からのみ                 |

Core と Synthesis を private にしているのは **IAM**（`allUsers` の invoker バインディングを
張らないこと）であって、ingress ではない。前段にロードバランサが無く、Cloud Run の外から
到達する必要のあるものも無いので、ingress を絞っても障害モードが増えるだけ。
`gemma-serving` だけは IAM に加えて `INGRESS_TRAFFIC_INTERNAL_ONLY` にしてあり、
これが §8.4 で「手元から 403」を証拠にできる根拠になっている。

各エージェントサービスに投入される共通環境変数:
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `VAULT_BACKEND=firestore` /
`FIRESTORE_DATABASE` / `VAULT_COLLECTION` / `GEMMA_MODEL` / `OTEL_ENABLED`、
および自分の Agent Card 用の `A2A_PUBLIC_URL` / `A2A_HOST` / `A2A_PROTOCOL`。
Core にはこれに加えて `GOOGLE_GENAI_USE_VERTEXAI=1` と `GEMINI_MODEL`。

### 3.6.1 サービスアカウントと IAM

SA と権限（すべて `infra/terraform/iam.tf` で宣言）:

| SA             | Firestore          | Vertex AI         | run.invoker (被)         | logging/trace |
| -------------- | ------------------ | ----------------- | ------------------------ | ------------- |
| `sa-gateway`   | `datastore.user`   | —                 | —                        | ○             |
| `sa-core`      | **なし（意図的）** | `aiplatform.user` | gateway から             | ○             |
| `sa-synthesis` | `datastore.user`   | —                 | gateway から             | ○             |
| `sa-gemma`     | —                  | —                 | gateway / synthesis から | ○             |

**`sa-core` に Firestore ロールを与えないことがこのプロジェクトの中核**。Core Agent が
Token Vault を読めないのはコード上の約束ではなく IAM 上の事実であり、いまはそれが
読んで diff できる Terraform の設定として存在している、というのが売り。
デモで見せる検証コマンド:

```bash
gcloud projects get-iam-policy all-thinkgs \
  --flatten="bindings[].members" \
  --filter="bindings.members:sa-core@all-thinkgs.iam.gserviceaccount.com" \
  --format="value(bindings.role)"
# 期待: roles/aiplatform.user / roles/logging.logWriter / roles/cloudtrace.agent のみ
# datastore が 1 行も出ないことが「構造的保証」の証拠
```

バインディングは `google_project_iam_binding` ではなく `google_project_iam_member` を使う。
`_binding` はロール全体に対して authoritative なので、Google 管理のサービスエージェントを
含む既存メンバーを剥がしてしまう。

> 旧 `iam.sh` の「初回は警告が出る」注記は不要になった。Terraform の `depends_on` が
> 単一 apply 内で `run.invoker` の付与を Cloud Run サービスの後に並べるので、
> 付与が失敗する初回ウィンドウ自体が存在しない。

### 3.7 なぜ Direct VPC egress が要るのか

`gemma-serving` は internal ingress。ところが Cloud Run の既定の下り通信は VPC を経由しない
ため、**Cloud Run から Cloud Run の internal ingress を呼ぶと 403 になる**。そこで呼ぶ側に
Direct VPC egress を付ける。Terraform ではこう書く:

```hcl
vpc_access {
  egress = "PRIVATE_RANGES_ONLY"
  network_interfaces {
    network    = "default"
    subnetwork = "default"
  }
}
```

これを付けるのは **`gateway-agent` と `synthesis-agent` だけ**。`core-agent` には VPC egress を
**付けていない**。Core が到達するのは Vertex AI（パブリックエンドポイント）だけなので、
VPC 経路を持たせても何も得られないため。

`PRIVATE_RANGES_ONLY` なので、Vertex AI や Firestore など外部宛はそのまま素通りする。
`all-thinkgs` に `default` VPC と `us-central1` の `default` サブネット (10.128.0.0/20) が
存在することは確認済みなので、追加作成は不要（要件は `/26` 以上で、`/20` はこれを満たす）。
この参照のために `compute.googleapis.com` を有効化しておく必要がある（§3.4）。

Serverless VPC Access コネクタを使わない理由: コネクタ VM が常時課金され、
provisioning にも数分かかる。Direct VPC egress は追加リソースなしで同じ効果が得られる。

### 3.8 設定を壊さないための仕組み

`terraform fmt` / `terraform validate` / `tflint` は lefthook の pre-commit フック
（`infra/terraform/**/*.tf` にスコープ）と、CI の専用 `terraform` ジョブの両方で走る。
手元では:

```bash
just tf-fmt          # その場で整形
just tf-fmt-check    # 差分の検出
just tf-validate     # バックエンドも認証情報も無しで検証
just tf-lint         # tflint
```

`just tf-validate` と CI ジョブはどちらも `-backend=false` を使うので、state バケットの
認証情報が無くても動く。4 つとも `just fmt` / `just fmt-check` / `just lint` / `just check` の
集約エントリポイントからも呼ばれる。

---

## 4. サービス間認証（**コード側の実装要件**）

Cloud Run の「認証を必須にする」設定は **IAM による認証**であって、呼び出し側が
**ID token** を `Authorization: Bearer` で付けないと 403 になる。
アクセストークン（`print-access-token`）ではなく **ID token** である点に注意。
その token を受け入れさせるのが呼び出し先の `roles/run.invoker` で、これらのバインディングは
`infra/terraform/iam.tf` の `google_cloud_run_v2_service_iam_member.invoker` リソース。

エージェント側の実装者向け（`agents/common/` に置くべきヘルパ）:

```python
# 呼び出し先 Cloud Run サービスの URL を audience にした ID token を取得する。
# Cloud Run 上では metadata server 経由で、そのサービスの SA として発行される。
import google.auth.transport.requests
import google.oauth2.id_token


def id_token_for(audience: str) -> str:
    req = google.auth.transport.requests.Request()
    return google.oauth2.id_token.fetch_id_token(req, audience)


def a2a_headers(target_url: str) -> dict[str, str]:
    # audience は「クエリやパスを含まないサービスのベース URL」でなければならない。
    # 例: https://core-agent-257034533412.us-central1.run.app
    return {"Authorization": f"Bearer {id_token_for(target_url)}"}
```

必要な呼び出し（すべて ID token 必須）:

| 呼び出し元 | 呼び出し先 | audience             |
| ---------- | ---------- | -------------------- |
| gateway    | core       | `CORE_BASE_URL`      |
| gateway    | synthesis  | `SYNTHESIS_BASE_URL` |
| gateway    | gemma      | `GEMMA_BASE_URL`     |
| synthesis  | gemma      | `GEMMA_BASE_URL`     |

実装上の注意:

- **audience はベース URL のみ。** `/v1/chat/completions` などのパスを含めると 403 になる
- `OllamaLlm` は `GEMMA_BASE_URL`（`/v1` を含む）を叩くが、`Authorization` ヘッダの
  audience は `/v1` を除いたベース URL で作ること
- ローカル開発では metadata server が無いので、`google-auth-library` の
  `getIdTokenClient` は `GOOGLE_APPLICATION_CREDENTIALS` の SA キーを使う。キーを
  置きたくない場合はローカル Ollama で回す（http なので ID トークンは付与されない）
- トークンは約 1 時間有効。ホップ毎に取り直すのは無駄なので、期限管理付きでキャッシュする

---

## 5. コスト試算

単価は Cloud Billing API から取得した `us-central1` の実 SKU（2026-08 時点、USD）。

| SKU                              | 単価                                 |
| -------------------------------- | ------------------------------------ |
| NVIDIA L4, ゾーン冗長**なし**    | `0.0001867` / GPU-sec = **$0.672/h** |
| NVIDIA L4, ゾーン冗長あり        | `0.0002909` / GPU-sec = $1.047/h     |
| Services CPU (instance-based)    | `0.000018` / vCPU-sec                |
| Services Memory (instance-based) | `0.000002` / GiB-sec                 |

### インスタンスが起きている間の時間単価

`gemma-serving`（GPU 1 + 8 vCPU + 32GiB、`cpu_idle = false`）:

| 内訳                     | $/h            |
| ------------------------ | -------------- |
| L4 GPU（ゾーン冗長なし） | 0.672          |
| CPU 8 vCPU               | 0.518          |
| Memory 32 GiB            | 0.230          |
| **小計**                 | **$1.421 / h** |

エージェント 3 サービス（各 1 vCPU + 1GiB）: 1 つあたり $0.072/h → 3 つで **$0.216/h**

> **全部起きている状態の合計: 約 $1.64 / 時間**
> （ゾーン冗長ありにすると $2.01/h。約 23% 増）

### 実際にかかる額

`min_instance_count = 0` なので、**アイドル時は $0**。課金されるのは
リクエスト処理中とアイドルタイムアウト（既定 ~15 分）の間だけ。
`gpu_enabled=false` で apply している間はほぼ無料で、これも quota 待ちにこの経路を
勧める理由のひとつ。

| シナリオ                                       | 概算                     |
| ---------------------------------------------- | ------------------------ |
| デモ動画の撮影（3 時間、GPU 常時起動）         | **約 $4.9**              |
| 開発中の散発的な利用（1 日 1 時間相当）        | 約 $1.6 / 日             |
| **消し忘れて 24h 起動しっぱなし**              | **約 $39 / 日** ← 要注意 |
| Cloud Build（Gemma、e2-highcpu-32 × 25 分）    | 約 $0.5 / 回             |
| Firestore / Artifact Registry / state バケット | 無料枠内〜数十セント     |

**GPU の消し忘れが唯一の事故要因。** 作業を終えたら必ず §10 のテアダウンを実行すること。
Gemini（Vertex AI）はトークン課金で、デモ規模なら数十セント程度。

---

## 6. GPU quota

新規プロジェクトの Cloud Run GPU quota は **0** のことが多い。`gpu_enabled=true` で
デプロイする前に確認する。

### 確認

```sh
just quota-status
```

このレシピは `gcloud alpha services quota list --service=run.googleapis.com` を `nvidia` で
フィルタして実行し、続いて申請済みの quota preference を一覧する。

Console からの確認・申請:
**IAM & Admin → Quotas & System Limits** → Service = _Cloud Run Admin API_ で
`nvidia` をフィルタ。

### 申請する quota 名

`gemma-serving` は `gpu_zonal_redundancy_disabled = true` を設定しているので、**上の行**を申請する。

- `Total Nvidia L4 GPU allocation without zonal redundancy, per project per region` ← **これ**
- `Total Nvidia L4 GPU allocation with zonal redundancy, per project per region`

### 申請手順 (gcloud)

**`all-thinkgs` では 2026-08-23T23:06Z に申請済み。** 使用したコマンド:

```sh
EMAIL=you@example.com \
JUSTIFICATION="Hackathon project ... need 1x L4 in us-central1 for the demo." \
just quota-request
```

このレシピは `gcloud alpha quotas preferences create` を
`--quota-id=NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` と `--preferred-value=1` で
ラップし、リージョンは `REGION` 環境変数（既定 `us-central1`）から取る。

quota-id は `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`。
`...PerProjectPerRegion` ではない点に注意（間違えても静かに失敗するので嵌まりやすい）。

状態確認:

```sh
just quota-status
```

読み方:

| フィールド                      | 意味                                           |
| ------------------------------- | ---------------------------------------------- |
| `reconciling: true`             | 審査中                                         |
| `quotaConfig.grantedValue: '0'` | 未承認。`gpu_enabled=false` でデプロイすること |
| `quotaConfig.grantedValue: '1'` | **承認済み。** `just tf-apply` を実行してよい  |

現時点の状態: preference id `34528bab-4b5b-47f1-82da-cec57b21a95d`、
`reconciling: true`、`grantedValue: 0` = **審査中**。デプロイ前に再確認すること。

### 申請手順 (Console)

1. Console の Quotas ページで対象の行を選択 → **EDIT QUOTAS**
2. Region = `us-central1`、New limit = **1**（`max_instance_count = 1` に合わせる。
   大きい数字を出すと審査が長引くので、必要最小限で出すこと）
3. 申請理由を英語で書く。例:
   > Hackathon project (All Things Agentic Hackathon, submission due 2026-08-31).
   > Serving Gemma 3 with Ollama on Cloud Run GPU for a privacy-preserving
   > multi-agent gateway. Need 1x L4 in us-central1 for demo and video recording.
4. 承認まで**数分〜数営業日**。締切があるので**最優先で最初に出しておくこと**

### 審査中、および通らなかった場合

| 段階 | 対応                                                                                  |
| ---- | ------------------------------------------------------------------------------------- |
| 0    | **残り 33 リソースを今すぐ入れる**: `just tf-apply gpu_enabled=false`（§3.5）         |
| 1    | `just tf-apply gemma_model=gemma3:4b` に落とす（3.3GB。それでも L4 は必要）           |
| 2    | 別リージョンで申請: `just tf-apply region=us-east4` / `europe-west1` / `europe-west4` |
| 3    | GPU を諦めて Vertex AI 経由にする（下記）                                             |

---

## 7. GPU が取れない場合のフォールバック（Vertex AI Model Garden）

**これは妥協であって、既定の構成ではない。** 採用する場合はデモで必ず差分を説明すること。

Gemma を自前ホストせず、Vertex AI Model Garden の Gemma エンドポイントを使う。

```bash
# Model Garden で Gemma がデプロイ可能か確認（読み取りのみ）
gcloud ai model-garden models list --region=us-central1 --filter="gemma" 2>/dev/null | head
```

そのうえで `gemma-serving` を構成から外し、エージェントをエンドポイントに向ける。

```bash
just tf-apply gpu_enabled=false
```

Terraform 側に Model Garden 用の変数は無いので、`GEMMA_BACKEND=vertex` と
`GEMMA_ENDPOINT_ID` を `gateway-agent` / `synthesis-agent` に配線するには
`infra/terraform/locals.tf` の `local.agent_services` に追記して再 apply する。
`gcloud run services update` でやってはいけない（次の apply で戻される）。
同じ編集で `local.sa_project_roles`（`infra/terraform/iam.tf`）の `sa-gateway` と
`sa-synthesis` に `roles/aiplatform.user` を足す必要もある。

### 信頼境界のトレードオフ（重要）

本プロジェクトの主張は「機微データを触るモデルは**自分たちが動かすコンテナの中**に置く」こと。
Model Garden 経由にすると、こうなる:

- **失われるもの**: 「Gemma は自前ホストで、生 PII は自分たちのコンテナから一歩も出ない」
  という主張。トークン化**前**の生テキストが Google のマネージド推論サービスへ渡る
- **残るもの**: Core（Gemini）に渡るのは依然としてマスク済みテキストのみ。
  `sa-core` に Firestore ロールが無いという構造的保証もそのまま。データはプロジェクト内に留まる
- **正味**: 外部 SaaS の LLM に生データを投げるよりは遥かにマシだが、
  「境界の内側でホストしている」とは言えなくなる。Cloud Run GPU 構成とは**強度が違う**

したがって、デモ本番は GPU 構成で行うのが望ましい。§6 の quota 申請を最優先で出し、
審査中は `gpu_enabled=false` で作業を進めること。

---

## 8. 検証

### 8.1 デプロイ状態

```bash
just urls      # デプロイ済みサービスと URL
just health    # 各エージェントの /healthz に ID token 付きで疎通
just tf-output # Terraform の output（deterministic_urls を含む）
```

`just health` は存在しないサービスには `not deployed` と出す。quota 待ちのあいだ
`gemma-serving` がこの行になるのが期待動作。

### 8.2 Gateway（公開・認証不要）

```bash
GATEWAY_URL=$(gcloud run services describe gateway-agent \
  --region=us-central1 --format='value(status.url)')

curl -sS "${GATEWAY_URL}/healthz"
curl -sS "${GATEWAY_URL}/.well-known/agent.json" | jq .
```

### 8.3 Core / Synthesis（要 ID token）

**アクセストークンではなく ID token**を使う。

```bash
CORE_URL=$(gcloud run services describe core-agent --region=us-central1 --format='value(status.url)')

curl -sS -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  "${CORE_URL}/.well-known/agent.json" | jq .

# 認証が実際に効いていることの証明（403 が返るのが正解）
curl -s -o /dev/null -w "no-auth -> HTTP %{http_code}\n" "${CORE_URL}/.well-known/agent.json"
```

> `gcloud auth print-identity-token` が返すのは**あなた自身**の ID token。
> これで通るのは、あなたが Owner だから。サービス間は各 SA の ID token を使う（§4）。

`just agent-card core-agent` はこのトークン処理を代わりにやってくれる。

### 8.4 Gemma（internal ingress なので外からは届かない）

ローカルからは **到達しないのが正常**。境界が効いている証拠になる。

```bash
GEMMA_URL=$(gcloud run services describe gemma-serving --region=us-central1 --format='value(status.url)')
curl -s -o /dev/null -w "from laptop -> HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${GEMMA_URL}/api/tags"
# 403 が期待値
```

疎通確認は gateway 経由の診断エンドポイント、もしくはログで行う
（`just logs-service gemma-serving`）。

### 8.5 Firestore の TTL

```bash
gcloud firestore fields ttls list --collection-group=token_vault --database='(default)'
```

### 8.6 エンドツーエンド

```bash
curl -sS -X POST "${GATEWAY_URL}/v1/query" \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Reply to Taro Yamada (taro@example.com, 090-1234-5678) about his order."}' | jq .
```

確認すべき点: Core に渡ったのはマスク済みか / leak check が通ったか / 最終回答が
リハイドレートされているか / OKF レコードが付いているか。
（エンドポイントのパスはコード担当の実装に合わせて読み替えること）

---

## 9. デモ動画用「Google Cloud で動いている証拠」の撮り方

審査で効くのは「本当にクラウドで動いている」ことが分かる画。以下を撮る。

### 9.1 Console（画で見せる）

1. **Cloud Run のサービス一覧** — 4 サービスが `us-central1` に並んでいる。
   URL と各サービスの SA 列が見えるようにする
2. **`gemma-serving` の詳細 → Container(s) タブ** — **GPU: 1 × NVIDIA L4** の表示。
   これが GPU デプロイの一番の証拠
3. **`gemma-serving` の Networking タブ** — Ingress control = _Internal_
4. **`core-agent` の Security タブ** — SA = `sa-core@...`、認証が Required
5. **IAM ページで `sa-core` を検索** — ロールが `aiplatform.user` 等のみで
   **Firestore が無い**ことを見せる（これが本プロジェクトの肝）
6. **Firestore → token_vault** — TTL 有効、ドキュメントに `expires_at` が入っている
7. **Cloud Trace** — 1 リクエストが gateway → core → synthesis と 3 ホップしている waterfall
8. **Logs Explorer** — `session_id` で串刺しにしたホップ毎の構造化ログ

### 9.2 ターミナル（数秒ずつ）

```bash
# 4 サービスと、それぞれの SA
gcloud run services list --region=us-central1 \
  --format="table(metadata.name, status.url, spec.template.spec.serviceAccountName)"

# GPU が本当に付いていること
gcloud run services describe gemma-serving --region=us-central1 \
  --format="yaml(spec.template.spec.containers[0].resources, spec.template.metadata.annotations)" \
  | grep -iE 'gpu|accelerator|cpu|memory'

# Core は Firestore を持たない（構造的保証）
gcloud projects get-iam-policy all-thinkgs --flatten="bindings[].members" \
  --filter="bindings.members:sa-core@all-thinkgs.iam.gserviceaccount.com" \
  --format="value(bindings.role)"

# 認証が効いている（403）/ ID token 付きなら通る（200）
curl -s -o /dev/null -w "no auth  -> %{http_code}\n" "${CORE_URL}/.well-known/agent.json"
curl -s -o /dev/null -w "with ID  -> %{http_code}\n" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${CORE_URL}/.well-known/agent.json"
```

インフラが宣言的になったので追加で撮る価値があるもの: `infra/terraform/iam.tf` を数秒、
`sa-core` に `roles/aiplatform.user` しか与えていないブロックまでスクロールした状態で映す。
「Firestore ロールが無い」ことは、それを裏付ける `gcloud` の出力の隣に、コミット済みの
コードとして見えているほうが信じやすい。

### 9.3 撮影のコツ

- **プロジェクト ID `all-thinkgs` を必ず画面に入れる**（Console のヘッダか URL バー）。
  ローカルのモックではないことの一番簡単な証明
- 公開 URL（`https://gateway-agent-257034533412.us-central1.run.app`）をブラウザの
  アドレスバーに映す。`localhost` が映っていると台無し
- **GPU は撮影前に暖めておく。** コールドスタートで 1〜2 分待つ画は動画が持たない。
  撮影直前にダミーリクエストを 1 発投げてインスタンスを起こしておく
- 4 分の尺なので、Console 巡回は 30〜40 秒に収め、残りは実際の動作（マスク → Gemini →
  leak check → リハイドレート）に使う

---

## 10. テアダウン

**GPU の課金を止めるのが最優先。作業を終えたら必ず実行する。**

```bash
just tf-destroy
```

Terraform が確認を求めたうえで、管理下のものをすべて削除する。Cloud Run 4 サービス、
SA 4 つとそのロールバインディング、invoker バインディング、Artifact Registry リポジトリ
（イメージ込み）。

意図的に残るものが 2 つある。

| リソース              | 残る理由                                                                  |
| --------------------- | ------------------------------------------------------------------------- |
| Firestore `(default)` | `deletion_policy = ABANDON` — Token Vault と監査レコードを残すため        |
| 有効化した 9 つの API | `disable_on_destroy = false` — 無効化すると他のワークロードに影響するため |

Firestore を destroy せず abandon するのは意図的で、`just tf-destroy` がデモの証跡ごと
持って行けてしまってはいけないから。本当に消したい場合は、state から外したうえで
Console から手で消す。（旧 `just destroy` の `DELETE_FIRESTORE=1` / `DELETE_SA=1` /
`DELETE_IMAGES=1` フラグは廃止。SA とイメージは通常の destroy で消える。）

Terraform state バケットは Terraform のライフサイクルの外にあるので、`just tf-destroy` では
残る。だから後から `just tf-apply` するときは、bootstrap からではなくクリーンな再作成で済む。

確認:

```bash
just urls        # 空であること
just tf-output   # output が無いこと
```

他は動かしたまま GPU サービスだけ止めたい場合:

```bash
just tf-apply gpu_enabled=false
```

これは quota 待ちのときと同じスイッチで、セッション間にフリートを寝かせる方法としても
これが最適。GPU 課金が止まり、残り 33 リソースは立ったままで、`just tf-apply` を打てば
エージェントサービスに触らずに Gemma が戻ってくる。
