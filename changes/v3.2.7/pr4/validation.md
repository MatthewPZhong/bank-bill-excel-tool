# PR4 验证记录

基线 PR3 `be71707b`，macOS arm64、合成 XLSX、临时主库/归档/输出。应用保持 3.2.6，业务生产入口关闭。

| 检查 | 当前实际结果 |
| --- | --- |
| 六类证据与损坏矩阵 | 每类 12 种，共 72 项损坏拒绝；另验证伪关系类型、类型往返、零差异、分页与命名 |
| 真实 Main/Publisher/Archive | 12 项：全部 7 个导出 action；发布前/提交未观察/归档前进程退出；文件篡改；目标变化；实际写出取消；归档失败；ACK 后本地写入失败；旧 owner 隔离；诊断退休保护 |
| 最终 Electron 专项 | 77 PASS / 0 FAIL / 0 SKIP，62075 ms；包含新增导出与既有 Archive TaskLifecycle |
| 首次 release-check | lint / smoke PASS；7059 PASS / 3 既有 SKIP / 1 FAIL，共 7063 项，452 文件；失败是旧测试对 Main runtime.get 的固定调用次数 |
| 固定次数测试修订 | 明确核验新增 BizOP 装配恰好 1 处，排除后仍验证原有 14 处；Toolbox 专项 11 PASS / 0 FAIL；完整 release-check 正在复跑，最终结果将补记 |
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
