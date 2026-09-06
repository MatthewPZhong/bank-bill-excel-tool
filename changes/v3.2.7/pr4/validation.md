# PR4 验证记录

2026-09-06 PR234 修复新增大 SST 回归：Electron 36.9.5 / Node 22.19.0，7 PASS / 0 FAIL / 0 SKIP，15777 ms；日志 `/tmp/bizop-pr234-sst-tests.log`。包含实际双原件 OP_RAW / FLOW_RAW 发布和磁盘缓存清理边界，全部临时合成文件。下列历史完整检查不代表本轮重跑，最终串行 PR 的 release-check 单独记录。

本轮另跑既有两个导出测试文件，20 PASS / 0 FAIL / 0 SKIP，23310 ms；包含六类输出、72 项损坏注入、真实发布/取消/反馈丢失及重启恢复。与新增文件合计 27 个独立测试，日志 `/tmp/bizop-pr234-export-regression.log`。受影响文件 eslint、check-vars（无重要变量命中）、git diff --check 通过。

基线 PR3 `be71707b`，macOS arm64、合成 XLSX、临时主库/归档/输出。应用保持 3.2.6，业务生产入口关闭。

| 检查 | 当前实际结果 |
| --- | --- |
| 六类证据与损坏矩阵 | 每类 12 种，共 72 项损坏拒绝；另验证伪关系类型、类型往返、零差异、分页与命名 |
| 真实 Main/Publisher/Archive | 12 项：全部 7 个导出 action；发布前/提交未观察/归档前进程退出；文件篡改；目标变化；实际写出取消；归档失败；ACK 后本地写入失败；旧 owner 隔离；诊断退休保护 |
| 最终 Electron 专项 | 77 PASS / 0 FAIL / 0 SKIP，62075 ms；包含新增导出与既有 Archive TaskLifecycle |
| 首次 release-check | lint / smoke PASS；7059 PASS / 3 既有 SKIP / 1 FAIL，共 7063 项，452 文件；失败是旧测试对 Main runtime.get 的固定调用次数 |
| 固定次数测试修订 | 明确核验新增 BizOP 装配恰好 1 处，排除后仍验证原有 14 处；Toolbox 专项 11 PASS / 0 FAIL；最终完整 release-check 结果见下行 |
| 最终完整 release-check | exit 0；lint / smoke PASS；7060 PASS / 3 既有 SKIP / 0 FAIL，共 7063 项、452 文件；53/53 集成脚本，2488/2488 PASS，470439 ms |
| check-vars | `freezeWorkerBatchContext` Critical、局部 `state`；关联复核见 review.md；smoke 已通过 |
| git diff --check | 通过 |

第一次完整检查因单元固定次数断言失败，未进入集成层，不能把它写成完整 release-check 通过。修订只调整新增装配的统计边界，未放宽旧 policy 的 production false、既有 14 处调用或 canary 约束。

## 资源实测

Electron 36.9.5 / Node 22.19.0，10 万行单日 FLOW，账户全异，金额全部精确文本回退。真实导入后运行 FLOW_RAW 的完整 expected→writer→actual→Publisher→Archive→ACK，两个目录均为临时目录并已清理。

| 指标 | 第二轮实际测量 |
| --- | --- |
| 生成合成输入 / 导入 | 2461 / 17232 ms |
| 完整导出 | 66464 ms |
| 业务行 / 说明行 / 页 | 100000 / 200002 / 2 |
| XLSX | 31336314 B |
| expected / writer / actual | 20728 / 10804 / 34364 ms |
| worksheet 流最大积压 | 133164 B |
| worker 报告进程 RSS / Main 采样进程 RSS 峰值 | 314998784 / 318046208 B（后者约 303 MiB） |
| Main 20ms 定时器最大额外延迟 | 13 ms |
| 原 native / Publisher 关闭 / 剩余 lease | true / true / 0 |

RSS 为同一 Electron Node 进程（包含 Main 和线程）的采样，不是单线程 heap 或 OS 硬峰值。第二轮已经包含 RAW 原件核验的独立容量准入；最后文件/页签命名与说明中的全名补充在该测量之后完成，最终 Electron 77 项已覆盖命名。两轮性能值不合计。

```bash
npm run release-check
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/biz-op-v327-export.test.js tests/unit/main-process/biz-op-v327-export-main.test.js tests/unit/main-process/archive-task-lifecycle.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/export-scale.js 100000
node scripts/check-vars.js
```

日志在本 worktree `outputs/pr4-validation/`。Windows 新模块成功链、2200 万输入/最大结果并集及高基数说明、Excel/WPS 实际打开、真实资金人工样例没有执行，仍是 PR6 生产启用的门禁。本机未修改用户业务数据库、原件或外部结果副本。

最终完整检查与提交 cb97cddf 的源码一致。单元阶段 163883 ms，旧固定次数断言已修正并包含在全量中；所有集成脚本通过。自动同步的集成耗时文档留在本地证据目录，恢复仓库中的旧时间值，不提交无行为变化的耗时差异。

PR5 接线时补充了 Publisher 等待容量期间的取消边界：取得容量后、记录 STARTED 和调用 Publisher 前再次检查取消。原 worker 已退出但 Publisher 尚未开始时，返回 cancelled，保留 NOT_STARTED 事实供恢复清理；已经开始的 Publisher 仍等待真实关闭和权威结果。专项真实 Main 测试现为 13 PASS / 0 FAIL（26192 ms），新增测试实际占满容量后取消并验证旧目标未改变、Task cancelled、恢复 ready、租约归零。本次小修未重复完整 release-check；上表完整结果对应修复前基线。
