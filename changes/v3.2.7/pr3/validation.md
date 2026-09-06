# PR3 验证记录

2026-09-06 PR233 评论修复：合入 PR1b / PR2 修复后，使用 Electron 36.9.5 / Node 22.19.0 重跑两个计算测试文件，32 PASS / 0 FAIL / 0 SKIP，20674 ms。新增 manifest 异步核验期间取消和提交成功后取消两项，分别检查原结果、版本计数及 receipt 不变和新结果成功保留。日志 `/tmp/bizop-pr233-review-tests.log`；以下原完整验证数据仍是历史基线，本轮完整 release-check 在串行 PR 汇总后另记。

基线 PR2 `bf196156`。macOS arm64；临时 userData、合成 XLSX、真实 Archive / TaskLifecycle / native worker / Main 目录提交。应用仍为 3.2.6，生产功能开关关闭。

| 检查 | 实际结果 |
| --- | --- |
| release-check 完整进程 | exit 0；lint / smoke PASS；当时单元 7040 PASS、3 既有 SKIP、0 FAIL；53/53 集成脚本，2488/2488 PASS，488836 ms |
| 最终基线完整单元 | PR2 E02 补充后再跑：7041 PASS / 3 既有 SKIP / 0 FAIL，共 7044 项、450 文件，198569 ms |
| 最终 Electron 专项 | 52 PASS / 0 FAIL / 0 SKIP，48287 ms；PR3 30 + PR2/writer 22，重复不累计 |
| 17 组业务 oracle | 所有批准样例通过真实原列 XLSX 导入、固定清单、SQLite 计算和 19 列比对 |
| 真实宿主故障及边界 | 11 项：缺日、坏分片、历史独立、巨大描述组、真实取消、提交前/后 Main 退出、generation 变化、精度/键/片段、删除重算 |
| eslint / git diff --check | 提交前通过 |

初轮发现缺端英文原因代码与批准样例命名不一致，已修正；提交入口严格补每日流水后，旧人工夹具增加必需 FLOW，保留原件预期数从 2 改为 3，相应清理断言已独立及最终全量复验。未降低业务或持久化校验。

完整 release-check 的单元阶段在 PR2 最后一个 E02 测试合入前开始，最终单元和 Electron 专项另跑并包含该修正；没有把先前 7040 写成包含全部最终测试。集成脚本不引用本期新适配，仍是既有功能回归。完整 release-check 后的自动集成耗时文档保存为本地证据，不提交纯耗时差异。

## 资源实测

Electron 36.9.5 / Node 22.19.0。每档两端 OP 各 100000 行，FLOW 100000 行，共 300000 输入。每档独立临时库，实际生成并导入 XLSX。RSS 是含 Main、worker 和导入后保留内存的进程采样，不是单独线程 heap，也不是瞬时硬峰值保证。

| 指标 | 三组互不相交键 | 全部同一键 / 高基数描述 |
| --- | --- | --- |
| 合成文件生成 / 导入 | 6542 / 74838 ms | 6421 / 78305 ms |
| 计算总时间 | 13717 ms | 4558 ms |
| 业务 / 差异行 | 300000 / 300000 | 1 / 1 |
| 说明行 | 500005 | 200006 |
| 结果总字节 / 分片 | 351076352 B / 5 | 79265792 B / 2 |
| 进程采样 RSS 峰值 | 416989184 B（约 398 MiB） | 402243584 B（约 384 MiB） |
| Main 20ms 定时器最大延迟 | 23 ms | 36 ms |
| 输入 / 工作 / 输出连接峰值 | 1 / 1 / 1 | 1 / 1 / 1 |
| 输出事务 | 200 | 50 |
| 实际 carrier closed | true | true |

阶段 load / index / group / resultCopy / seal 分别为 1378 / 884 / 6374 / 2245 / 2635 ms 与 1356 / 470 / 1969 / 3 / 560 ms。单键两端各 10 万描述候选集合相同、逆序导入；集合比较依靠磁盘，不把候选值全部装入 JS Set。

## 剩余验收与复跑

未运行两端各 400 万 OP + 1400 万流水、Windows 本期成功链、Excel/WPS 实际打开、真实资金人工样例。目录 fsync 的 Windows unsupported 不通过削弱屏障消除；PR6 启用门禁保持。16 MiB 磁盘停止线和分片初值尚非目标规模估算模型。

```bash
npm run release-check
node --test tests/unit/main-process/biz-op-v327-compute.test.js tests/unit/main-process/biz-op-v327-compute-main.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/biz-op-v327-compute.test.js tests/unit/main-process/biz-op-v327-compute-main.test.js tests/unit/main-process/biz-op-v327-import.test.js tests/unit/main-process/biz-op-v327-import-main.test.js tests/unit/backend/sqlite-candidate-writer.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/compute-scale.js 100000 disjoint --keep
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/compute-scale.js 100000 skew --keep
```

原始日志保存在本 worktree `outputs/pr3-validation/`，不向远端上传大量生成文件。
