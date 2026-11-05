# Harbor Extension 内网落地手册

本手册面向平台实施人员。开发者只维护自己的扩展仓库：本机用 Node 调试，合并到 `dev` 或 `prod` 后推送 GitHub。平台 Jenkins Job 接收 push webhook，校验仓库、分支和提交，构建不可变内容版本，再切换 GKE。扩展仓库没有 Jenkinsfile、GCS 凭据或上传接口。

## 1. 先收集这些参数

为 **Dev 和 Prod 分别**填写下表；不要共用桶、部署身份或 Jenkins Job 的 GKE 权限。代码中的 `REPLACE_WITH_*` 是故意留下的配置项。

| 参数 | Dev | Prod | 用途 |
| --- | --- | --- | --- |
| GCP project、GKE cluster、location、namespace | 待填 | 待填 | Jenkins 连接集群及部署命名空间 |
| GCS bucket | 待填 | 待填 | `releases/<40位版本ID>/` 内容快照 |
| 镜像 repository 与 SHA-256 digest | 待填 | 待填 | 固定平台镜像版本 |
| PAT 服务 URL、Harbor origin、登录 URL | 待填 | 待填 | `deploy/k8s/overlays/<env>/kustomization.yaml` |
| 可信 ingress 代理 CIDR | 待填 | 待填 | `FORWARDED_ALLOW_IPS`，不能用 `*` |
| Jenkins agent 的 GCP 身份 | 待填 | 待填 | 写对应桶、只修改对应 GKE Deployment |
| GKE `harbor-extensions` KSA 的身份 | 待填 | 待填 | 只读对应桶 |
| PAT/SSO、connector 凭据、下游身份验证负责人 | 待填 | 待填 | 真实联调与验收 |

GKE 集群需启用 Workload Identity Federation for GKE 和 Cloud Storage FUSE CSI，且运行 Linux 节点；实际版本与限制按 [Google 的 CSI 文档](https://docs.cloud.google.com/kubernetes-engine/docs/concepts/cloud-storage-fuse-csi-driver)核对。平台部署身份使用短期凭据；扩展仓库不保存服务账号密钥。

## 2. 建立平台资源

1. 建 Dev/Prod 桶、namespace、平台镜像仓库和独立身份。将 `deploy/k8s/overlays/dev`、`prod` 的占位值替换为真实参数；平台镜像必须用 digest 固定。配置 Kubernetes Secret `harbor-extensions-secrets`，包括 `HARBOR_IDENTITY_KEY` 和所需 `HARBOR_SECRET_*`；不要提交明文。
2. 给 GKE KSA 桶只读权限；给 Jenkins 对应环境身份桶写权限及该 namespace 中 `harbor-extensions` Deployment 的读取、patch、rollout 权限。限制服务入口和网关出口到实际 Harbor、PAT、connector 目的地；这部分网络规则依赖内网地址，仓库未填通配策略。
3. 在 `deploy/policy/dev/` 和 `deploy/policy/prod/` 维护环境独立的 `grants.yaml`、`nav.yaml`。初始文件为空授权；样例 `config/grants.yaml` 只用于本机模拟，不能直接带入生产。
4. 渲染并检查两套清单。占位值未填时，第二条命令应失败：

   ```bash
   kubectl kustomize deploy/k8s/overlays/dev >/tmp/harbor-dev.yaml
   kubectl kustomize deploy/k8s/overlays/prod >/tmp/harbor-prod.yaml
   node scripts/check-gke-manifest.mjs dev
   node scripts/check-gke-manifest.mjs prod
   ```

## 3. 首次生成空版本

发布脚本需要先有一个可读取的旧版本。由**平台实施人员**在受控环境执行一次空版本初始化；其中不含任何开发者扩展代码。版本 ID 取已合入平台 `main` 的 40 位 commit SHA，并分别写入 Dev/Prod 桶。

```bash
cd harbor-extensions
BOOT_SHA=$(git rev-parse HEAD)
DEV_BUCKET=REPLACE_WITH_DEV_BUCKET
PROD_BUCKET=REPLACE_WITH_PROD_BUCKET
for TARGET in dev prod; do
  if [ "$TARGET" = dev ]; then BUCKET="$DEV_BUCKET"; else BUCKET="$PROD_BUCKET"; fi
  EMPTY=$(mktemp -d)
  OUTPUT=$(mktemp -d)
  node scripts/compose-release.mjs "$EMPTY" - "$OUTPUT" "$BOOT_SHA" "deploy/policy/$TARGET"
  (cd backend && python -m harbor_platform.validate --root "$OUTPUT")
  gcloud storage rsync "$OUTPUT" "gs://$BUCKET/releases/$BOOT_SHA" --recursive
  rm -rf "$EMPTY" "$OUTPUT"
done
```

此命令只用于**新桶的首次初始化**，不要覆盖已有 release 前缀。空版本包含 `.keep`、环境政策和 `config/release.json`，确保 FUSE 可见必要目录。将两套 overlay 的初始 release ID 设为 `BOOT_SHA`，确认第 2 节的清单检查通过后，再由平台分别连接各自的 GKE 集群并部署：

```bash
gcloud container clusters get-credentials REPLACE_WITH_DEV_CLUSTER --location REPLACE_WITH_DEV_LOCATION --project REPLACE_WITH_DEV_PROJECT
kubectl apply -k deploy/k8s/overlays/dev
kubectl -n REPLACE_WITH_DEV_NAMESPACE rollout status deployment/harbor-extensions
gcloud container clusters get-credentials REPLACE_WITH_PROD_CLUSTER --location REPLACE_WITH_PROD_LOCATION --project REPLACE_WITH_PROD_PROJECT
kubectl apply -k deploy/k8s/overlays/prod
kubectl -n REPLACE_WITH_PROD_NAMESPACE rollout status deployment/harbor-extensions
```

检查每个环境两副本 Ready，`/readyz` 返回 `ok: true`、`config_errors: 0`，且 Deployment 的 `HARBOR_RELEASE_ID` 与桶中 `config/release.json` 一致。失败时先核对 KSA 对桶的读取、CSI sidecar 日志、镜像和 Secret。

## 4. 配置 GitHub 与 Jenkins

1. 平台 Jenkins Job 的 Pipeline 定义使用 **Pipeline script from SCM**，SCM 指向受保护的平台 `main`，脚本路径为 `harbor-extensions/jenkins/Jenkinsfile.deploy`。部署 agent 使用 `harbor-gke-deploy` 标签，预装 Node 22、Python 3.12、`gcloud`、GKE auth plugin、`kubectl`、`jq`，并通过平台管理的短期 GCP 身份访问环境资源。
2. 每个扩展仓库建一个平台管理的 Jenkins Job，固定 `HARBOR_JOB_MODE=extension`、`HARBOR_REGISTERED_REPO` 和 `HARBOR_EXTENSION_GIT_URL`。GitHub push webhook 只提供 `X-GitHub-Event`、`repository.full_name`、`ref`、`after`；映射为 `HARBOR_WEBHOOK_*`。Jenkinsfile 会检查仓库、`dev`/`prod` 分支及实际 checkout SHA。Job 的桶、namespace、GKE project/cluster/location 参数由平台配置，不能取自 webhook。
3. 再建一个 `HARBOR_JOB_MODE=policy` 的平台 Job，监听平台 `main` 对 `deploy/policy/dev/` 或 `deploy/policy/prod/` 的变更。它给两环境发布新快照，确保权限撤销不用等扩展的下一次提交。
4. Jenkins webhook 入口验证 GitHub 签名，并限制触发者与 Build/Configure 权限。Generic Webhook Trigger 的 token 本身可用 SYSTEM 身份触发 Job，不能当作审批；详见 [Jenkins Job 配置](../jenkins/README.md)和[插件说明](https://plugins.jenkins.io/generic-webhook-trigger)。
5. 每个扩展仓库采用 `dev` 和 `prod` 受保护分支，禁止直接推送；要求 PR 检查和 CODEOWNERS 审批。把模板 `.github/CODEOWNERS` 中的平台团队占位 handle 换成真实值。connector、环境地址、扩展权限声明须经平台评审。仅在这些规则生效后，才由平台 Job 设置 `HARBOR_PLATFORM_REVIEW_ENFORCED=true`。

扩展仓库**不放有部署凭据的 Jenkinsfile**。Jenkins 官方指出，允许仓库作者修改 Jenkinsfile 会扩大凭据暴露面；参见[安全说明](https://www.jenkins.io/doc/book/security/securing-org-folders-and-multibranch-pipelines/)。

## 5. 用一个真实扩展验收

1. 开发者用 Node CLI 创建独立仓库，在本机启动 `env/local.yaml` 指向的 connector 后端，运行 `harbor extension validate` 和 `harbor extension dev`。确认 UI 调用确实到达本机后端。
2. 合并 PR 并推送 `dev`。确认对应 Jenkins Job 的 webhook 仓库/ref/SHA 与 GitHub 一致；Job 输出的 bundle 只含该扩展的 `web/`、manifest 与 Dev connector 地址。确认 GCS 新前缀、release marker、GKE 滚动完成、两副本 Ready，再在 Harbor Dev 中执行真实 PAT/SSO、AD 组、connector 读/写与审计检查。
3. 在 Dev 更新第二版，保持 Prod 不动；比较两个环境的 Deployment release ID 和页面内容。然后经 `dev` → `prod` PR 推送，确认 Prod 使用 `env/prod.yaml` 地址，并经过同样的权限与功能检查。
4. 修改平台 Dev/Prod 政策并推送平台 `main`，确认政策 Job 发布版本；尤其验证撤销授权后旧权限立即不再可用。对两仓库同时推送做一次并发演练：输掉 Deployment 版本比较的 Job 应安全失败，重跑后基于最新版本合成。

本机 `deploy/sim/run.sh verify` 已验证“临时 Git 远端 → 分支 bundle → 对象存储 → FUSE → 页面热更新”，但它使用 kind/rclone。真实 GCS CSI 的缓存、两副本一致性、Jenkins webhook 和身份链路必须在内网环境完成本节验收。

## 6. 回退与放行

扩展代码回退优先使用 Git revert 并推送对应分支，Jenkins 会用**当前平台政策**合成新版本；这样不会恢复已撤销的 grants。发布脚本在新 Pod 无法就绪时，仅当该 Job 仍拥有 Deployment 当前版本才自动 `rollout undo`。平台紧急操作可把 Deployment 的 `HARBOR_ROOT` 与 `HARBOR_RELEASE_ID` 一起切回一个已验证的快照，但若涉及权限撤销，应先合成保留当前政策的新快照，不要直接回到旧 grants。

只有第 5 节真实环境验收通过后，才把该环境标记为可供内部开发社区使用。具体参数和责任人填在本手册第 1 节；未填参数、未配置分支保护或未通过 GKE 演练，都不属于已放行状态。
