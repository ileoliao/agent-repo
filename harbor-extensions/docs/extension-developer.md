# 社区扩展开发指南

[English](extension-developer.en.md)

本文面向扩展开发者。**一个扩展一个 Git 仓库**；`dev` 分支对应 Dev，受保护的 `prod` 分支对应 Prod。两条分支可以长期保留不同代码，例如 Dev 正在做大版本时，Prod 继续运行稳定版。

平台提供网关、Portal、SDK、发布流水线和权限政策。你维护扩展页面、connector 契约及三个环境的后端地址。扩展代码和 connector 声明会经过平台审查；声明能力不等于获得授权。

## 1. 创建仓库

从平台仓库的 `harbor-extensions/` 目录安装一次 CLI，然后切到**平台 Git checkout 之外**的工作目录创建扩展：

```bash
npm ci
npm link
cd /path/to/team-workspace
harbor extension new my-extension \
  --owner "Your Team" --contact you@company.internal --description "What it does"
cd my-extension
```

当前 CLI 从平台仓库安装；也可以直接运行 `node /path/to/harbor-extensions/cli/harbor.mjs`。本机开发只需 Node，不需要 Python、Docker 或 Kubernetes。为新目录创建独立 GitHub 仓库和 `dev`、`prod` 分支，并请平台团队将仓库登记到发布 Job。**在 Jenkins webhook 和分支保护接通前，合并代码不会自动部署。**

仓库主要文件：

| 路径 | 你维护的内容 |
| --- | --- |
| `extension.yaml` | 名称、负责人、可见范围、申请使用的能力 |
| `web/` | 要发布的静态页面和资源；框架构建产物放这里 |
| `connectors/*.yaml` | connector 名称、允许的方法和路径、AD 组、数据级别 |
| `env/local.yaml` | 本机联调的后端地址 |
| `env/dev.yaml`、`env/prod.yaml` | Dev、Prod 中同一 connector 的真实后端地址 |

`env/*.yaml` 只放地址，不放凭据。源码、测试和后端代码可以在仓库中，但不要放进 `web/`。平台只打包验证过的 `web/`、manifest 和目标环境 connector 配置；connector 密钥由平台注入。

## 2. 本机联调

先把 `env/local.yaml` 中的地址指向本机启动的 connector 后端。模板默认是 `http://127.0.0.1:3000`。然后在扩展仓库根目录运行：

```bash
harbor extension validate
harbor extension dev
```

打开 CLI 打印的预览地址。页面通过 `harbor.connector("my-extension-api").get("/health")` 调用后端；请以实际 connector 名称替换示例。CLI 会按仓库声明的路由和能力转发到 `env/local.yaml` 所指地址，不必另外配置一个“本地覆盖地址”。保持静态资源路径为相对路径，扩展页面运行在沙箱 iframe 中。

本地预览使用固定的测试身份，能验证页面、路由和到本机后端的链路。真实 PAT、AD 组、平台 grants、connector 凭据和下游签名身份要在 Dev 验证。`validate` 会检查三个环境文件，并拒绝指向非本机的 local 地址。

## 3. 发布和晋级

1. 提交 PR 到 `dev`。通过检查与审查后合并，GitHub 推送触发平台 Jenkins 将该分支发布到 Dev。
2. 在 Harbor Dev 检查页面、connector 读写、目标 AD 组、授权拒绝和审计记录。Dev 失败时继续修改 `dev`，不影响 Prod。
3. 准备晋级时提交 `dev` → `prod` PR。检查代码和 `env/prod.yaml` 指向的后端，经审查合并后由 Jenkins 发布 Prod。
4. 若只需修复 Prod，可从 `prod` 建修复分支并合入 `prod`，随后把修复带回 `dev`。

请平台团队先配置两个分支的保护规则、CODEOWNERS、PR 检查和仓库登记。connector 地址、允许路由、AD 组、写能力、可见范围和导航晋级需要平台评审。扩展仓库不放有部署凭据的 Jenkinsfile，不保存服务账号密钥；开发者没有 `publish` 命令或内容上传 API。

发布由平台 Job 完成，开发者通常只需要看 PR 检查、Jenkins 发布结果和 Dev/Prod 页面。发布失败时保留提交并联系平台维护者处理，不要绕过 GitHub 分支直接上传内容。
