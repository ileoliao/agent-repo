# airflow-run-migrator

用 REST API 把 Airflow 2.x 中**失败的 DAG run** 迁移到 Airflow 3.x，迁移内容包括任务状态和 XCom。迁移后，在 Airflow 3 里只续跑没完成的任务，下游任务 `xcom_pull` 拿到的值和类型与原来一致。

全程只调用两边的 API，不访问元数据库。

## 已验证环境

| | 版本 |
|---|---|
| 源 | Airflow 2.9.2（Python 3.11） |
| 目标 | Airflow 3.3.2（Python 3.12） |

测试 DAG 见 `e2e/`。第一组任务（4 个 producer）在 2.x 中成功，推送了 26 个 XCom，类型覆盖 dict、嵌套 list、int、float、bool、None、中文、空容器、datetime、date、Decimal、tuple、set、字符串 `"7"`、`"True"`、`"None"`，以及内嵌 datetime 的 dict。中间任务失败，导致两个下游任务 upstream_failed。

迁移后的结果：
- XCom 回读比对 26/26 一致，比较时类型也要严格一致。
- 恢复 DAG 后，4 个 producer 没有重跑（try 0）。失败的任务和两个下游任务都成功，下游对所有 `xcom_pull` 的值和类型断言全部通过，包括 `xcom_pull(task_ids=[...])` 一次取多个的情况。

## 流程

1. 读取 2.x 中这个 run 的信息、任务实例，以及所有成功任务的 XCom。
2. 把每个 XCom 还原成带类型的值，生成兼容性报告。
3. 在 3.x 中：暂停 DAG，用同样的 `run_id`、`logical_date`、`data_interval`、`conf` 创建 run，把成功的任务标成 success，写入它们的 XCom，再逐个回读做严格比对。
4. DAG 保持暂停。检查好 Variables 和 Connections 之后手动恢复，scheduler 只会执行没完成的任务。

## 前置条件

**Airflow 2**
- `[api] auth_backends` 包含 `airflow.api.auth.backend.basic_auth`
- `[api] enable_xcom_deserialize_support = True`，并重启 webserver。不开的话，datetime 等对象会以内部字符串形式返回，脚本会拦下并报错。

**Airflow 3**
- DAG 已经部署，并且已被 dag-processor 解析。
- 同一个 DAG 下不能已经存在相同 `logical_date` 的 run，`(dag_id, logical_date)` 是唯一约束。预检查会提前发现这个问题。
- 认证方式三选一：`--dst-user/--dst-password`（通过 `POST /auth/token` 获取 token）、`--dst-token`，或者都不传（适用于 SimpleAuthManager 且开启了 `all_admins`）。

依赖：`pip install requests`。如果提示文件用 YAML 格式，还需要 `pyyaml`。

## 用法

```bash
# 1. dry-run：只输出报告，不写入任何数据
python migrate_failed_run.py \
  --src-url http://af2:8080 --src-user u --src-password p \
  --dst-url http://af3:8080 --dst-user u --dst-password p \
  --dag-id my_dag --run-id 'scheduled__2024-09-30T00:00:00+00:00' --dry-run

# 2. 存在歧义值时，严格模式会停下，并打印一段 hints JSON。
#    把它存成 hints.json，按真实类型修正后再执行：
python migrate_failed_run.py ... --hints hints.json

# 批量迁移：--run-id 可以重复传多个
python migrate_failed_run.py ... --run-id r1 --run-id r2 --hints hints.json

# 只重新做一次比对
python migrate_failed_run.py ... --hints hints.json --verify-only
```

退出码：`0` 成功；`1` 回读比对不一致；`2` 预检查未通过或存在歧义值，此时没有写入任何数据。

## 为什么需要类型提示

Airflow 2.9 的 XCom API 返回的是 `str(value)`。

- **容器里的值**是精确的。dict 和 list 内部用的是 `repr()`，字符串带引号，`datetime(...)`、`Decimal(...)` 都能识别。脚本用一个白名单 AST 解析器还原这些值，不会执行任意代码。
- **顶层标量**有歧义：整数 `7` 和字符串 `"7"` 返回的都是 `7`。同理，`True`/`None`、数字、`2024-09-30 08:30:15+00:00`（datetime 还是字符串）、`2024-09-30`（date 还是字符串）都无法区分。

提示文件的格式：

```json
{
  "producer_c.numstr": "str",
  "producer_d.dec": "decimal",
  "producer_b.when": "datetime",
  "my_task.*": "str",
  "*.row_count": "int"
}
```

- key 只支持三种写法：`task.key`、`task.*`、`*.key`。前面的写法优先。
- 不支持其他 glob 写法，因为 `task.s*` 这种写法会误匹配到 `task.set`。
- 可用的类型：`str int float bool none decimal datetime date json`。
- 同一个 DAG 的多个 run 可以共用一份提示文件。
- 加 `--no-strict` 时，脚本按字面类型猜测，只输出警告、不拦截。

## 类型降级（Airflow 3 的限制）

Airflow 3 的 `POST xcomEntries` 只接受纯 JSON。包含 `__classname__`、`__type` 等序列化标记的值会被直接拒绝（422），已实测确认。所以以下类型只能降级，报告里会逐条列出，需要在 DAG 代码里自行解析：

| 原类型 | 写入 3.x 后 |
|---|---|
| datetime / date / time | ISO 8601 字符串 |
| Decimal、UUID、其他对象 | `str()` |
| timedelta | 总秒数（float） |
| tuple | list |
| set | 排序后的 list |
| dict 的非字符串 key | 转成字符串 |

None、bool、int、float、str、list、字符串 key 的 dict 都能原样往返。

## 已知行为

- 2.9.2 中值为 None 的 XCom，API 会返回 HTTP 500。脚本据此判定值就是 None，并在报告里注明。
- 3.3.2 中读取 XCom 时如果带上 `deserialize=true`，字符串会被再解析一次（比如 `"7"` 变成 7）。脚本校验时不带这个参数。显示端读取时也建议不要带。
- 不支持动态映射任务（`.expand()`）。遇到时会报错并拦截。
- 自动跳过 `skipmixin_key` 这类内部 key（可用 `--skip-keys` 调整）。

## 端到端测试

`e2e/` 中有两个版本的测试 DAG（`dag_id` 相同），以及对应的 `hints.json`：

1. 在 2.x 中设置 Variable `should_fail=1`，触发一次 run，使它失败。
2. 在 3.x 中部署 DAG，并设置 Variable `should_fail=0`。
3. 运行迁移脚本。
4. 恢复 DAG，查看 `after_fail` 和 `consumer` 的日志，应该输出 `XCHECK ALL OK`。
