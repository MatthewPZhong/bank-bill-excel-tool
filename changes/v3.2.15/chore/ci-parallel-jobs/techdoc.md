# TechDoc — v3.2.15 Windows CI 拆成并行 job，集成测试分片并发执行（B43）

> status: done
> created: 2026-11-05
> updated: 2026-11-05（第 3 片调整）
> 目标版本：v3.2.15
> 适用分支：`chore/ci-parallel-jobs`
> 分支创建基线：`v3.2.14` 正式标签 → `245bae04`
> 依据：[knowledge/backlog.md B43](../../../../knowledge/backlog.md)（2026-11-04 用户提出并决定；第 3 项“只改文档的提交跳过完整检查”不在本项）

## 1. 现状与耗时

`.github/workflows/build-windows.yml` 的 `smoke-test` 在一台 windows-latest 上依次运行 `npm run release-check`，`build` 在其后。#246 合入提交 `06771b01` 的运行 41993644465 各阶段耗时：

| 阶段 | 耗时 |
| --- | --- |
| 准备（checkout、Node、npm ci、两个 Windows 前置步骤） | 约 1 分 20 秒 |
| lint | 10 秒 |
| 架构检查 | 10 分 37 秒 |
| smoke | 31 秒 |
| 单测（9860 项，Node 默认并发） | 72 分钟 |
| 集成测试（94 个脚本串行） | 48 分 45 秒 |
| `smoke-test` 合计 | 2 小时 13 分 |
| `build`（成功运行 41956219990） | 约 4 分钟 |

集成测试中耗时最长的是 `toolbox-large-split-multi-sheet`（12.8 分钟）和 `toolbox-large-file-stream`（10.2 分钟）。

## 2. 方案

### 2.1 job 结构

```
release-check-static ─┐   lint → check:architecture → smoke
release-check-unit ×5 ┼─→ smoke-test（汇总 + Windows 专项步骤）─→ build
release-check-integ ×2┘   单测 5 片；集成测试 2 片、每片并发 2
```

- `release-check-static`：`npm run lint && npm run check:architecture && npm run smoke`，架构检查的 policy base 解析（`ci-policy-base.js`、`ARCHITECTURE_BASE_REF`）随之移入。
- `release-check-unit`：matrix `shard: [1, 2, 3, 4, 5]`，`UNIT_TEST_SHARD=${{ matrix.shard }}/5`，`npm run test:unit`（分片方式见 2.3）。
- `release-check-integration`：matrix `shard: [1, 2]`，`INTEGRATION_SHARD=${{ matrix.shard }}/2`、`INTEGRATION_CONCURRENCY=2`，`npm run test:integration`。
- 两个 matrix 都 `fail-fast: false`，一片失败不取消其他片，便于一次看到全部失败。
- `smoke-test`：`needs` 上述三个 job，`if: ${{ !cancelled() }}`。原有 Windows 专项步骤不变，仍在全部检查结束之后串行运行，不与全量单测同机并发。专项步骤包括：
  - 内存包身份、通用反馈弹窗；
  - 启动进程适配器、打包 canary 计时探针；
  - carrier、SQLite teardown；
  - 主面板对齐。

  `Run release checks` 步骤改为 `node scripts/ci/verify-release-check-jobs.js`，读取 `toJSON(needs)`，三个 job 都为 `success` 才通过。matrix job 的 result 只有全部分片成功时才是 `success`。
- `build`：仍 `needs: smoke-test`，不变。

### 2.2 必需检查与门禁

- **必需检查名不变**：`main` 保护规则要求 `smoke-test` 和 `build`，两个 job 名都保留，不需要改保护规则。
- **防止 skipped 被当作通过**：依赖的 job 失败时，下游 job 默认显示 skipped，而必需检查可能把 skipped 当作通过。`smoke-test` 用 `!cancelled()` 保证依赖失败时仍然运行，并在汇总步骤失败。
- **覆盖不变**：`scripts/ci/verify-release-check-jobs.js` 的 `RELEASE_CHECK_JOBS` 记录各 job 承担的命令。单测核对它们按顺序合起来恰好是 `package.json` 的 `release-check`，并且与 workflow 中各 job 的运行命令一致；单测、集成测试的分片合起来是全部。
- **v3.2.1 守卫**：每个并行 job 都沿用 `smoke-test` 的以下步骤，单测逐字核对条件一致：
  - checkout 前的“Reject unauthorized v3.2.1 final-gate invocation”；
  - 绑定 PR head 的 checkout（`fetch-depth: 0`）；
  - 一次性修复血缘；
  - 检查步骤上的 release-check 运行条件。
- **本地不变**：本地 `npm run release-check` 的入口与内容不变；`release-windows.yml`（打标签发布）仍完整串行运行 release-check。发布 workflow 一版只跑一次，并作为最终门禁，所以本项不拆。

### 2.3 单测分片

`scripts/run-unit-tests.js` 读取 `UNIT_TEST_SHARD=i/n`；格式不对时报错退出，不静默跑全部或跑空；未设置时仍用 glob 跑全部（本地不变）。

最初透传为 Node 原生 `--test-shard`（按排序后的文件轮流分配，3 片），实跑两次都不均衡，并出现负载相关的超时：

| 运行 | 单测各片 | 失败 |
| --- | --- | --- |
| 42071950489（`4a054a9b`） | 15.8 / 20.2 / 31.4 分钟 | Windows CRLF（契约测试，`819f4663` 已修）；`biz-op-v327-delete-main` 的 DELETE_ASSOCIATED 恢复超过 70 秒期限（平时约 40 秒） |
| 42077862105（`819f4663`） | 13.5 / 15.1 / 43.9 分钟 | `biz-op-v327-compute-main` 真实 Main 子进程超过 30 秒上限 |

按 run 41993644465 的用例耗时把顶层用例对回源文件估算：`biz-op-v327-archive-owner-backfill` 约 15 分钟，其次是 `v3-2-4-release-evidence` 和几个起真实 Main 进程的业务OP文件。Node 的轮流分配恰好把其中最重的几个放进第 3 片，同一台机器上同时运行，互相拖慢后超时。

现改为 runner 自己选文件，把本片文件清单直接传给 `node --test`（`selectShardFiles`）。改为 5 片后，第一版规则如下：

1. 负载敏感文件（`LOAD_SENSITIVE_UNIT_FILES`）先各放一片：起真实 Main 进程、带固定时限的 5 个业务OP文件。
2. 再轮流分配其他耗时最长的文件（按实测从长到短）。
3. 其余按路径轮流分配。

这一版在 PR #247 上全部通过（run 42086209141，单测各片 20.1 / 12.5 / 19.2 / 9.3 / 8.0 分钟）。合入 release 后，同样的分配在 run 42090975671 上第 3 片跑了 36.0 分钟，整轮被拖到 40.6 分钟。

**第 3 片变慢的原因**：两次第 3 片的文件完全相同。把两次运行的顶层用例耗时按源文件汇总后：

- `biz-op-v327.test.js` 一个文件就占 14.4 / 26.8 分钟，其中 1024、128、32 个真实 Task 来源的扫描用例约 13 分钟。它不在第一版的耗时名单里，是按路径轮流分进第 3 片的。
- 文件内的用例依次运行，所以它的耗时就是所在片的下限。`node --test` 会把文件参数按路径排序后再启动（本机已验证，传入顺序不起作用）。`biz-op-v327-*.test.js` 都排在它前面，它要等前面的文件让出位置才开始。
- 第二次那台机器偏慢的主要是磁盘：
  - SQLite 和真实进程类文件普遍慢了约 2 倍；
  - 纯计算的 `position-reconciliation-service` 和 `recon-id-fix-jpm-durable-e11-b` 耗时基本不变。

  其他 4 片两次耗时相近。

按“文件按路径排序进入队列、每片并发 3”的模型，用实测耗时模拟各片，与两次实际耗时相差都在 1.5 分钟以内（含约 1 分钟的准备时间）。据此改为按实测耗时分配：

1. 负载敏感文件按耗时从长到短各放一片。
2. 独占文件（`DEDICATED_UNIT_FILES`，目前只有 `biz-op-v327.test.js`）放进当前最轻的片，即只和最轻的负载敏感文件 `biz-op-v327-ipc` 同片，该片不再放其他文件，两个文件开跑即开始。片数少于 3 时不独占。
3. 其余文件按实测分钟数（`UNIT_FILE_MINUTES`）从长到短，每个放进当前估算分钟数最少的片。
   - 分钟数取自 run 42086209141，按源文件汇总，列出不少于 1 分钟的 34 个文件；
   - 其余文件按平均值 0.07 分钟计；
   - 测试增删后耗时有偏差时，按新的 CI 实测更新。

按 run 42086209141 的实测耗时模拟：

| 分配 | 各片（分钟） | 最慢一片 | 任一片落在慢机器上（×1.86） |
| --- | --- | --- | --- |
| 第一版 | 19.2 / 11.8 / 18.5 / 7.8 / 6.7 | 19.2 | 约 36 |
| 现行 | 15.7 / 12.4 / 13.4 / 15.8 / 14.4 | 15.8 | 约 29 |

各片 2～157 个文件，命令行最长约 1 万字符；超过 30000 字符（Windows 命令行上限 32767）时报错，提示增加分片数。

单测核对以下几点：
- 名单中的文件都存在；
- 各片不重不漏，敏感文件各在一片；
- 独占文件只和最轻的敏感文件同片；
- 其余各片估算分钟数相差不超过 1；
- 片数少于 3 时不独占。

### 2.4 集成测试分片与并发

`scripts/integration-runner.js`：

- **分片**：`INTEGRATION_SHARD=i/n`。已知耗时最长的脚本（`HEAVY_SCRIPTS_FIRST`，按 CI 实测从长到短）先轮流分到各片，其余按脚本名轮流分配，各片合起来恰好是全部脚本。分片运行不回写 `rules/integration-test-policy.md` 第七节（只有部分结果）。
- **并发**：`INTEGRATION_CONCURRENCY=k`，默认 1。
  - 为 1 时按脚本名串行，输出格式与原 runner 一致。
  - 大于 1 时，先逐个单独运行独占脚本，其余最多 k 个同时运行；失败输出在脚本结束时整段写出，不与其他脚本交错。
- **汇总**：汇总、退出码与第七节回写都按脚本名排序，与执行顺序无关。子进程由 `spawnSync` 改为异步 `spawn`，输出不再受 `spawnSync` 默认 1 MB 缓冲上限限制。
- **共享资源排查**：93 个脚本逐一 grep。
  - 临时目录：除 `pending-engine-migration` 用时间戳加随机数命名外，其余都用 `mkdtemp`，不会互相冲突。
  - 没有脚本监听端口；没有脚本写入仓库目录（golden 只读）；Documents、userData 都放在各自的临时目录里。
  - 只有 `renderer-lifecycle`、`packaged-memory-identity` 两个脚本会起 Electron 窗口。
- **独占名单**（`EXCLUSIVE_SCRIPT_PATTERN`，27 个）：
  - 起 Electron 窗口的脚本（焦点、截图会受其他窗口干扰）；
  - 名称含 `toolbox-`、`memory`、`admission`、`canary`、`idle-cleanup`、`concurrency`、`query-boundary`、`result-workbook` 的脚本：断言内存峰值、准入阈值、耗时；
  - `big-table-import`：被测路径按空闲内存或 CPU 数调整行为，例如工具箱行拆分的 `os.freemem()` 准入、大表导入的并行度闸门。

按 CI 实测耗时模拟：2 片、并发 2 时，最慢的一片约 22 分钟；不并发时约 25 分钟。

### 2.5 预计耗时

按 Node 原生 3 片实测两次，整轮 32.8 和 45.3 分钟（第二次第 3 片 43.9 分钟）。其余 job 两次的耗时：
- `release-check-static`：12.4～13.0 分钟；
- 集成测试两片：20.2～23.8 分钟；
- `smoke-test` 汇总：约 1.4 分钟。

改为 5 片均衡分配后，预计最慢的 job 是集成测试（约 22 分钟），一轮约 30 分钟。改动前约 2 小时 10 分。实测值见第 4 节。

## 3. 契约测试与校验器的调整

以下断言原本写死“`smoke-test` 里有执行 `npm run release-check` 的步骤”，随结构更新，原意保留：

| 位置 | 原断言 | 调整 |
| --- | --- | --- |
| `tests/unit/windows-build-contract.test.js` | `Run release checks` 步骤的条件与 `run: npm run release-check` | 条件不变，命令改为汇总脚本，并核对 `RELEASE_CHECK_JOB_RESULTS: ${{ toJSON(needs) }}` |
| `tests/unit/architecture/cli.test.js` | 两个 workflow 都含 `run: npm run release-check` | `release-windows.yml` 不变；`build-windows.yml` 核对三个并行命令与汇总脚本 |
| `scripts/validate-v3-2-1-release-evidence.js` | `smoke-test` 的 release-check 步骤条件 | 条件不变，命令改为汇总脚本；新增逐个核对并行 job 的守卫、checkout、血缘与运行条件 |
| 新增 `tests/unit/ci-release-check-jobs.test.js` | — | 命令覆盖、matrix 与分片参数、守卫与条件一致、`needs`/`!cancelled()`、job 顺序、汇总脚本判定 |

## 4. 验证

- 单测：runner 分片、并发、独占、真实 CLI（临时仓库，含失败退出码、分片不回写、完整运行回写）；单测 runner 分片（真实 CLI 两片合起来覆盖全部）；契约与校验器测试。
- 远端：开 draft PR `chore/ci-parallel-jobs → release/v3.2.15`，新 workflow 在 PR 上实跑，记录各 job 实际耗时；通过后合入 release。
- 实测耗时：
  - Node 原生 3 片的两次运行见 2.3。
  - 5 片均衡分配（run 42086209141，`082c04f6`）全部通过，整轮 27.6 分钟：
    - `release-check-static` 12.8 分钟；
    - 单测各片 20.1 / 12.5 / 19.2 / 9.3 / 8.0 分钟；
    - 集成测试两片 22.3 / 21.9 分钟；
    - `smoke-test` 1.6 分钟；
    - `build` 3.5 分钟。
  - 合入 release 后，同样的分配在 run 42090975671（`86a65ada`）上也全部通过，但整轮 40.6 分钟：单测第 3 片 36.0 分钟，原因见 2.3。按 2.3 调整后的实测待补。
  - 改动前约 2 小时 15 分（run 41993644465）。

## 5. 回滚

只涉及 CI 配置、两个 runner 的可选参数和测试。回滚即还原 `build-windows.yml` 与本分支的测试改动；runner 新参数默认关闭，本地与发布 workflow 不受影响。
