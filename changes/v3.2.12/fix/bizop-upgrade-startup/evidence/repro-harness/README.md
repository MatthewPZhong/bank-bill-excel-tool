# 复现与诊断工具 — fix/bizop-upgrade-startup

> 目标版本：v3.2.12 · 功能分支：`fix/bizop-upgrade-startup` · 基线：`v3.2.11`（`52b92b55`）
> 用途：复现、观察业务 OP 启动升级（`biz-op-v327` activation）的准入与旧数据校验。工具只观察和记录，不改变应用判定逻辑；不是生产代码，不打包进应用。
> 这是证据工具，不是门禁：`run.js` 的退出码不反映应用是否启动成功，结论要靠 `summarize.js` 和追踪文件人工判读。持续门禁见 [TechDoc §7.3](../../techdoc.md#73-门禁与实机)。
> 配套：[基线证据](../../baseline-evidence.md) · [Spec](../../spec.md) · [TechDoc](../../techdoc.md)

## 文件

| 文件 | 作用 |
| --- | --- |
| `hook.js` | 通过 `NODE_OPTIONS=--require` 加载到 Electron 主进程。记录调度器创建、每次资源申请及结果、受观察载体与 `runMemoryActivity` 的创建和退出，以及升级预检时刻的完整现场（`PRECHECK-SNAPSHOT`）；拦截启动失败弹窗以免阻塞；窗口出现约 4 秒后自动退出 |
| `run.js` | 用隔离的 `APP_USER_DATA_DIR` / `APP_DOCUMENTS_DIR` 拉起开发模式应用并加载钩子 |
| `summarize.js` | 打印 `trace.jsonl` 中与升级预检有关的关键事件 |
| `seed-legacy-side-dbs.js` | 用**旧版本自己的** `run-data-store` 往 userData 写入旧业务 OP 月度文件与主库行（测试数据） |
| `precheck-policy-probe.js` | 不启动 Electron，直接用生产内存策略验证“空闲通过 / 一个未退出载体即拒绝 / 载体退出后通过” |
| `side-db-upgrade-probe.js` | 验证旧版本建的月度文件在“原样”和“经当前 `openSideDb` 打开后”两种状态下，两轮 schema 校验的结果 |

## 环境变量（run.js）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BIZOP_APP_DIR` | 本仓库根目录 | 被测应用源码根目录；测旧版本时指向 `git archive` 解出的目录 |
| `BIZOP_REPRO_OUT` | `<系统临时目录>/bizop-upgrade-repro` | 输出根目录；每次运行写入 `<label>/trace.jsonl`、`electron-output.log` |
| `BIZOP_SIMULATE_WIN_X64` | 非 Windows 为 `1`，Windows 为 `0` | `1` 时把资格身份视为 win32/x64，并把 `os.totalmem` / `os.freemem` 固定为 16 GiB / 5 GiB |
| `BIZOP_REPRO_TIMEOUT_MS` | `150000` | 硬超时，到时 `SIGKILL` |

不要设置 `APP_CAPTURE_PATH` 或 `APP_STARTUP_MEASURE_AUTO_QUIT=1`：这两个变量会让应用跳过单实例锁，而首次升级的 `assertStartAllowed` 要求持有单实例锁（`src/main.js` 第 761–765 行决定是否申请锁，第 5097–5098 行的 `assertStartAllowed` 检查 `app.hasSingleInstanceLock()`）。

## 典型用法

```bash
# 1) 当前分支，全新 userData
node run.js fresh
node summarize.js "$TMPDIR/bizop-upgrade-repro/fresh/trace.jsonl"

# 2) 从 3.0.26 升级并带旧月度文件（F3 场景）
git -C <仓库根> archive "v3.0.26^{commit}" | tar -x -C /tmp/v3026
ln -s <仓库根>/node_modules /tmp/v3026/node_modules        # 3.0.26 与当前运行时依赖一致
BIZOP_APP_DIR=/tmp/v3026 node run.js v3026-base /tmp/ud-3026  # 让旧版本生成自己的 userData
node seed-legacy-side-dbs.js /tmp/v3026 /tmp/ud-3026
node run.js v3026-upgrade /tmp/ud-3026                        # 用当前分支打开同一 userData

# 3) 探针
node precheck-policy-probe.js
node side-db-upgrade-probe.js /tmp/v3026
```

## 限制与隐私

- **只能在开发模式使用。** Electron 官方文档说明，正式打包的应用中 `NODE_OPTIONS` 被禁止，仅放行 `--max-http-header-size` 和 `--http-parser`；因此无法在用户已安装的正式包上加载本钩子。
- 在非 Windows 机器上，模拟只覆盖资格身份和内存数值，不覆盖 Windows 的文件句柄、WAL、杀毒扫描等行为。
- **绝不要对真实用户数据的原件运行**：应用启动后会执行升级迁移、清空旧表并回收旧文件。只能使用经授权、做好保密的**副本**。
- `trace.jsonl` 只记录技术身份（actionKey、资源向量、调用帧中的 `src/` 相对路径），不记录 ownerKey、业务数据或本机路径；启动失败弹窗中的日志路径会被替换为占位符。
