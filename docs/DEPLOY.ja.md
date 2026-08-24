# デプロイ Runbook

対象プロジェクト: `all-thinkgs` / リージョン: **`us-central1`** / アカウント: `kei.of.nakayama@gmail.com`

このドキュメントは `infra/` と `serving/` の運用手順。アーキテクチャの意図は
[ARCHITECTURE.md](./ARCHITECTURE.md)、構成図は [diagram/architecture.drawio.png](./diagram/architecture.drawio.png)。

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

変更したい場合は `REGION=europe-west1 just deploy` のように環境変数で上書きできる。

---

## 2. 前提

```bash
gcloud config set project all-thinkgs
gcloud config set account kei.of.nakayama@gmail.com
gcloud auth login
gcloud auth application-default login   # ローカル開発用
```

必要な IAM（実行者本人）: `roles/owner` もしくは
`run.admin` + `iam.serviceAccountAdmin` + `datastore.owner` + `artifactregistry.admin` + `cloudbuild.builds.editor` + `serviceusage.serviceUsageAdmin`。

---

## 3. 手順

すべてのスクリプトは `set -euo pipefail` かつ**冪等**。途中で失敗しても、原因を直して
同じコマンドを再実行してよい。

### 3.0 設定の確認

```bash
source infra/common.sh && env | grep -E 'PROJECT_ID|REGION|GEMMA_MODEL'
```

既定値を変えたい場合のみ環境変数を export する（例: `export GEMMA_MODEL=gemma3:4b`）。

### 3.1 API 有効化

```bash
just enable-apis
```

有効化するもの: `run` / `compute` / `artifactregistry` / `cloudbuild` / `firestore` /
`aiplatform` / `iam` / `logging` / `cloudtrace`。

`compute.googleapis.com` が要るのは、Direct VPC egress で `default` VPC を参照するため
（§3.5 参照）。これが無いとサブネットの解決に失敗する。
（`all-thinkgs` は新規プロジェクトのため、ここで初めて有効化される）

### 3.2 サービスアカウントと IAM

```bash
just iam
```

作られる SA と権限:

| SA             | Firestore          | Vertex AI         | run.invoker (被)         | logging/trace |
| -------------- | ------------------ | ----------------- | ------------------------ | ------------- |
| `sa-gateway`   | `datastore.user`   | —                 | —                        | ○             |
| `sa-core`      | **なし（意図的）** | `aiplatform.user` | gateway から             | ○             |
| `sa-synthesis` | `datastore.user`   | —                 | gateway から             | ○             |
| `sa-gemma`     | —                  | —                 | gateway / synthesis から | ○             |

**`sa-core` に Firestore ロールを与えないことがこのプロジェクトの中核**。Core Agent が
Token Vault を読めないのはコード上の約束ではなく IAM 上の事実である、というのが売り。
デモで見せる検証コマンド:

```bash
gcloud projects get-iam-policy all-thinkgs \
  --flatten="bindings[].members" \
  --filter="bindings.members:sa-core@all-thinkgs.iam.gserviceaccount.com" \
  --format="value(bindings.role)"
# 期待: roles/aiplatform.user / roles/logging.logWriter / roles/cloudtrace.agent のみ
# datastore が 1 行も出ないことが「構造的保証」の証拠
```

> 初回実行時、Cloud Run サービスがまだ無いので `run.invoker` の付与は警告になる。
> `deploy.sh` の最後で `iam.sh` を自動的に再実行して収束させるので、そのままで問題ない。

### 3.3 Firestore

```bash
just firestore
```

Native モードの `(default)` DB を `us-central1` に作り、`token_vault` コレクションの
`expires_at` フィールドに TTL ポリシーを張る。

TTL の注意点:

- TTL フィールドは **timestamp 型**であること
- ポリシー有効化に **10 分以上**かかる
- 実削除は期限到来から **24 時間以内**（即時ではない）
- **したがって読み出し側（Synthesis）は `expires_at` を必ず自前でも検証すること。**
  TTL は容量管理であって、アクセス制御ではない

### 3.4 イメージのビルド

```bash
just build                              # 4 つ全部
just build gemma              # Gemma だけ
```

Artifact Registry の `agentic-fleet` リポジトリへ push する。

Gemma イメージは**モデルをビルド時に焼き込む**ため時間がかかる（`gemma3:12b` で 15〜25 分）。
`e2-highcpu-32` / disk 100GB / timeout 3600s で回す。ここを毎回やり直さないよう、
Gemma のビルドは一度成功したらタグを固定しておくとよい。

### 3.5 デプロイ

```bash
just deploy
```

`gemma → core → synthesis → gateway` の順にデプロイし、下流の URL を上流の環境変数に
配線する（`GEMMA_BASE_URL` / `CORE_BASE_URL` / `SYNTHESIS_BASE_URL`）。この順序は必須。

`GEMMA_BASE_URL` は OpenAI 互換の `/v1` パスまで含める
（例: `https://gemma-serving-xxxx.us-central1.run.app/v1`）。
`packages/common/src/config.ts` がこの形で検証する。

Core と Synthesis は **2 フェーズ** でデプロイする。A2A Agent Card には自分自身の公開
`https://` URL を載せる必要があるが、その URL は Cloud Run がサービス作成後に割り当てる
ため、初回デプロイの後に次を実行する:

```bash
gcloud run services update core-agent \
  --update-env-vars A2A_PUBLIC_URL=https://core-agent-xxxx.us-central1.run.app,A2A_HOST=core-agent-xxxx.us-central1.run.app,A2A_PROTOCOL=https
```

`just deploy` は両サービスについてこれを自動で行う。

公開範囲:

| サービス          | 認証                         | ingress      | 備考                           |
| ----------------- | ---------------------------- | ------------ | ------------------------------ |
| `gateway-agent`   | `--allow-unauthenticated`    | all          | 唯一の公開入口。デモ UI もここ |
| `core-agent`      | `--no-allow-unauthenticated` | all          | gateway の ID token のみ       |
| `synthesis-agent` | `--no-allow-unauthenticated` | all          | gateway の ID token のみ       |
| `gemma-serving`   | `--no-allow-unauthenticated` | **internal** | 境界内からのみ                 |

投入される共通環境変数:
`GOOGLE_CLOUD_PROJECT` / `GOOGLE_CLOUD_LOCATION` / `VAULT_BACKEND=firestore` /
`FIRESTORE_DATABASE` / `VAULT_COLLECTION`。Core にはこれに加えて
`GOOGLE_GENAI_USE_VERTEXAI=1` と `GEMINI_MODEL`。

#### なぜ Direct VPC egress が要るのか

`gemma-serving` は `--ingress internal`。ところが Cloud Run の既定の下り通信は
VPC を経由しないため、**Cloud Run から Cloud Run の internal ingress を呼ぶと 403 になる**。
そこで gemma を呼ぶ側（`gateway` と `synthesis`）に Direct VPC egress を付ける。

```
--network=default --subnet=default --vpc-egress=private-ranges-only
```

`private-ranges-only` にしているので、Vertex AI など外部宛はそのまま素通りする。
`all-thinkgs` に `default` VPC と `us-central1` の `default` サブネット (10.128.0.0/20) が
存在することは確認済みなので、追加作成は不要（要件は `/26` 以上で、`/20` はこれを満たす）。
この参照のために `compute.googleapis.com` を有効化しておく必要がある（§3.1）。

Serverless VPC Access コネクタを使わない理由: コネクタ VM が常時課金され、
provisioning にも数分かかる。Direct VPC egress は追加リソースなしで同じ効果が得られる。

---

## 4. サービス間認証（**コード側の実装要件**）

Cloud Run の `--no-allow-unauthenticated` は **IAM による認証**であって、
呼び出し側が **ID token** を `Authorization: Bearer` で付けないと 403 になる。
アクセストークン（`print-access-token`）ではなく **ID token** である点に注意。

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
    # 例: https://core-agent-xxxx.us-central1.run.app
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

`gemma-serving`（GPU 1 + 8 vCPU + 32GiB、`--no-cpu-throttling`）:

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

`--min-instances=0` なので、**アイドル時は $0**。課金されるのは
リクエスト処理中とアイドルタイムアウト（既定 ~15 分）の間だけ。

| シナリオ                                    | 概算                     |
| ------------------------------------------- | ------------------------ |
| デモ動画の撮影（3 時間、GPU 常時起動）      | **約 $4.9**              |
| 開発中の散発的な利用（1 日 1 時間相当）     | 約 $1.6 / 日             |
| **消し忘れて 24h 起動しっぱなし**           | **約 $39 / 日** ← 要注意 |
| Cloud Build（Gemma、e2-highcpu-32 × 25 分） | 約 $0.5 / 回             |
| Firestore / Artifact Registry               | 無料枠内〜数十セント     |

**GPU の消し忘れが唯一の事故要因。** 作業を終えたら必ず §8 のテアダウンを実行すること。
Gemini（Vertex AI）はトークン課金で、デモ規模なら数十セント程度。

---

## 6. GPU quota

新規プロジェクトの Cloud Run GPU quota は **0** のことが多い。デプロイ前に確認する。

### 確認

```sh
just quota-status
```

The recipe runs `gcloud alpha services quota list --service=run.googleapis.com`
filtered to `nvidia`, then lists the submitted quota preferences.

Console からの確認・申請:
**IAM & Admin → Quotas & System Limits** → Service = _Cloud Run Admin API_ で
`nvidia` をフィルタ。

### 申請する quota 名

`deploy.sh` は `--no-gpu-zonal-redundancy` を使うので、**上の行**を申請する。

- `Total Nvidia L4 GPU allocation without zonal redundancy, per project per region` ← **これ**
- `Total Nvidia L4 GPU allocation with zonal redundancy, per project per region`

### 申請手順 (gcloud)

**`all-thinkgs` では 2026-08-23T23:06Z に申請済み。** 使用したコマンド:

```sh
EMAIL=you@example.com \
JUSTIFICATION="Hackathon project ... need 1x L4 in us-central1 for the demo." \
just quota-request
```

The recipe wraps `gcloud alpha quotas preferences create` with
`--quota-id=NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion` and
`--preferred-value=1`, taking the region from `infra/common.sh`.

quota-id は `NvidiaL4GpuAllocNoZonalRedundancyPerProjectRegion`。
`...PerProjectPerRegion` ではない点に注意（間違えても静かに失敗するので嵌まりやすい）。

状態確認:

```sh
just quota-status
```

読み方:

| フィールド                      | 意味                                      |
| ------------------------------- | ----------------------------------------- |
| `reconciling: true`             | 審査中                                    |
| `quotaConfig.grantedValue: '0'` | 未承認。GPU デプロイはまだ失敗する        |
| `quotaConfig.grantedValue: '1'` | **承認済み。** `deploy.sh` を実行してよい |

現時点の状態: preference id `34528bab-4b5b-47f1-82da-cec57b21a95d`、
`reconciling: true`、`grantedValue: 0` = **審査中**。デプロイ前に再確認すること。

### 申請手順 (Console)

1. Console の Quotas ページで対象の行を選択 → **EDIT QUOTAS**
2. Region = `us-central1`、New limit = **1**（`--max-instances=1` に合わせる。
   大きい数字を出すと審査が長引くので、必要最小限で出すこと）
3. 申請理由を英語で書く。例:
   > Hackathon project (All Things Agentic Hackathon, submission due 2026-08-31).
   > Serving Gemma 3 with Ollama on Cloud Run GPU for a privacy-preserving
   > multi-agent gateway. Need 1x L4 in us-central1 for demo and video recording.
4. 承認まで**数分〜数営業日**。締切があるので**最優先で最初に出しておくこと**

### 通らなかった場合の退避

| 段階 | 対応                                                                    |
| ---- | ----------------------------------------------------------------------- |
| 1    | `GEMMA_MODEL=gemma3:4b` に落とす（3.3GB。それでも L4 は必要）           |
| 2    | 別リージョンで申請: `REGION=us-east4` / `europe-west1` / `europe-west4` |
| 3    | GPU を諦めて Vertex AI 経由にする（下記）                               |

---

## 7. GPU が取れない場合のフォールバック（Vertex AI Model Garden）

**これは妥協であって、既定の構成ではない。** 採用する場合はデモで必ず差分を説明すること。

Gemma を自前ホストせず、Vertex AI Model Garden の Gemma エンドポイントを使う。

```bash
# Model Garden で Gemma がデプロイ可能か確認（読み取りのみ）
gcloud ai model-garden models list --region=us-central1 --filter="gemma" 2>/dev/null | head

# エンドポイントにデプロイした後、gemma-serving を消して環境変数を差し替える
gcloud run services delete gemma-serving --region=us-central1 --quiet
gcloud run services update gateway-agent --region=us-central1 \
  --set-env-vars="GEMMA_BACKEND=vertex,GEMMA_ENDPOINT_ID=<ENDPOINT_ID>"
gcloud run services update synthesis-agent --region=us-central1 \
  --set-env-vars="GEMMA_BACKEND=vertex,GEMMA_ENDPOINT_ID=<ENDPOINT_ID>"
```

このとき `sa-gateway` と `sa-synthesis` に `roles/aiplatform.user` を追加する必要がある。

### 信頼境界のトレードオフ（重要）

本プロジェクトの主張は「機微データを触るモデルは**自分たちが動かすコンテナの中**に置く」こと。
Model Garden 経由にすると、こうなる:

- **失われるもの**: 「Gemma は自前ホストで、生 PII は自分たちのコンテナから一歩も出ない」
  という主張。トークン化**前**の生テキストが Google のマネージド推論サービスへ渡る
- **残るもの**: Core（Gemini）に渡るのは依然としてマスク済みテキストのみ。
  `sa-core` に Firestore ロールが無いという構造的保証もそのまま。データはプロジェクト内に留まる
- **正味**: 外部 SaaS の LLM に生データを投げるよりは遥かにマシだが、
  「境界の内側でホストしている」とは言えなくなる。Cloud Run GPU 構成とは**強度が違う**

したがって、デモ本番は GPU 構成で行うのが望ましい。§6 の quota 申請を最優先で出すこと。

---

## 8. 検証

### 8.1 デプロイ状態

```bash
gcloud run services list --region=us-central1 \
  --format="table(metadata.name, status.url, spec.template.spec.serviceAccountName)"
```

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

### 8.4 Gemma（internal ingress なので外からは届かない）

ローカルからは **到達しないのが正常**。境界が効いている証拠になる。

```bash
GEMMA_URL=$(gcloud run services describe gemma-serving --region=us-central1 --format='value(status.url)')
curl -s -o /dev/null -w "from laptop -> HTTP %{http_code}\n" \
  -H "Authorization: Bearer $(gcloud auth print-identity-token)" "${GEMMA_URL}/api/tags"
# 403 が期待値
```

疎通確認は gateway 経由の診断エンドポイント、もしくはログで行う。

```bash
gcloud run services logs read gemma-serving --region=us-central1 --limit=50
```

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

### 9.3 撮影のコツ

- **プロジェクト ID `all-thinkgs` を必ず画面に入れる**（Console のヘッダか URL バー）。
  ローカルのモックではないことの一番簡単な証明
- 公開 URL（`https://gateway-agent-....us-central1.run.app`）をブラウザのアドレスバーに
  映す。`localhost` が映っていると台無し
- **GPU は撮影前に暖めておく。** コールドスタートで 1〜2 分待つ画は動画が持たない。
  撮影直前にダミーリクエストを 1 発投げてインスタンスを起こしておく
- 4 分の尺なので、Console 巡回は 30〜40 秒に収め、残りは実際の動作（マスク → Gemini →
  leak check → リハイドレート）に使う

---

## 10. テアダウン

**GPU の課金を止めるのが最優先。作業を終えたら必ず実行する。**

```bash
just destroy
```

既定では Cloud Run の 4 サービスのみ削除する（Firestore・SA・イメージは残す）。
完全に消す場合:

```bash
DELETE_IMAGES=1 DELETE_SA=1 DELETE_FIRESTORE=1 just destroy
```

> `DELETE_FIRESTORE=1` は Token Vault と監査ログを消す。デモの証跡が必要な間は実行しないこと。

確認:

```bash
gcloud run services list --region=us-central1   # 空であること
```

GPU サービスだけ止めたい場合（設定は残す）:

```bash
gcloud run services update gemma-serving --region=us-central1 --max-instances=0
```
