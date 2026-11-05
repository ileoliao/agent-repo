# Harbor Extensions

Harbor Extensions 让团队以独立仓库交付扩展页面，并通过平台网关访问受控的内部系统。扩展只交付静态前端；业务数据和规则留在源系统或团队自己的后端。

## 选择你的文档

| 角色 | 文档 | 你要完成的事 |
| --- | --- | --- |
| 社区开发者 | **[扩展开发指南](docs/extension-developer.md) / [English](docs/extension-developer.en.md)** | 创建扩展、在本机联调 connector、通过 `dev`/`prod` 分支发布 |
| 平台维护者 | **[内网落地与运维手册](docs/internal-rollout.md) / [English](docs/internal-rollout.en.md)** | 配置 Jenkins、GitHub、GKE、GCS、身份与权限，并完成验收和回退 |

开发者本机只需要 Node。平台服务和真实部署另有 Python、Jenkins 与 GKE 依赖。当前仓库提供可运行的本地演示、发布脚本和部署清单；真实内网参数仍保留为占位值，接入前按平台手册完成配置与验收。

```text
独立扩展仓库 dev/prod 分支 ──▶ 平台 Jenkins ──▶ 不可变 GCS 版本 ──▶ GKE
                                                                    │
用户浏览器 ──▶ Harbor /extensions ──▶ 扩展沙箱 ──▶ 平台网关 ──▶ connector 后端
```

平台实现细节见[架构与需求](docs/requirements-and-architecture.md)、[部署清单说明](deploy/README.md)和 [Harbor React 集成](integrations/harbor-react/README.md)。
