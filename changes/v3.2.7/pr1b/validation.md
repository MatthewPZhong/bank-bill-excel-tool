# PR1b 本地验证

基线：PR1a `98976f6e69d2ad78893d050d424cbe18ee8f836a`。平台：macOS arm64、系统 Node 25.8.0、Electron 36.9.5 / Node 22.19.0。原 E5 包只读；生产开关关闭、版本仍为 3.2.6。本记录只代表本地实现与自动测试，不代表 Windows、真实业务或发布验收。

## 已完成

| 检查 | 结果 |
| --- | --- |
| PR1b 专项 | 当前 27 项；真实 Task/Archive/SQLite/原生 worker/平台/宿主覆盖 |
| 最终 Electron Node 专项 | 51 PASS / 0 FAIL / 0 SKIP，其中 PR1b 27 项、原共享关闭与宿主 24 项 |
| 动作/Task 清单及 Toolbox 聚焦回归 | 59 PASS / 0 FAIL；新增 12 身份并保留原调用者与历史 E13-G 快照复验 |
| release-check 单元阶段 | 6985 PASS / 3 SKIP / 0 FAIL；当次共 6988 项。随后新增的三项预算边界已单独 3/3 PASS，并计入最终 Electron 27 项 |
| release-check lint/smoke | PASS |
| release-check 集成阶段 | 53/53 脚本、2488/2488 检查 PASS；完整 release-check exit 0 |
| git diff --check | PASS |

完整日志保存在本 worktree 的 `outputs/pr1b-validation/`；计数不合并重复执行。追加的三个边界测试没有生产代码变更，系统 Node 聚焦 3/3 与最终 Electron 全专项均通过。

第一次完整回归发现旧启动清单测试仍定位直接 scan 调用，以及一个既有 ServiceHost 用例在负载下收到 unexpected exit。启动路径已修正并测试；ServiceHost 用例单独重跑及下一轮完整单元均通过，没有把未复现的问题改写成已修复的生产缺陷。

## 调度与内存证据

最终 Electron 运行使用真实 Main SQLite、RecoveryControl 和 Task 来源；仅复杂度三项固定注入准入时钟。deadline 的生产常量仍为 60000ms，另有真实在途调用/回收中途越过期限的状态和文件测试。

| 来源数 | 全量扫描 | Inspector / 持久 observation attempts | 累计评估 | 实测恢复墙钟 | Main RSS 结束/采样峰值 |
| --- | --- | --- | --- | --- | --- |
| 32 | 2 | 96 / 96 | 160 | 687 ms | 167510016 bytes |
| 128 | 2 | 384 / 384 | 640 | 2520 ms | 182829056 bytes |
| 1024 | 2 | 3072 / 3072 | 5120 | 23673 ms | 260653056 bytes |

旧模块来源量在这些临时夹具中为 0；以上不代表混合旧模块的全应用启动性能。RSS 采样含该测试进程其他夹具和 SQLite 缓存，不是内存上限保证。

4096 目录来源的完整 JSON 为 2138879 bytes；Electron 该点 RSS 为 631832576 bytes。第 4097 项拒绝，完整枚举累计收费 8193 单位，没有将截断数组交给平台。这是枚举容量证据，不是 4096 项全部恢复或账单规模验收。单来源和 decision 字节限额另以收紧参数验证拒绝路径。

之前并行完整回归时，真实时钟的 1024 项 Electron 试验在约 60067ms 到期并保留未决状态（383 次 Main，382 项完成）；不能承诺任意机器/负载一次完成 1024 项，也没有上调生产参数掩盖该事实。

## 复跑命令

```bash
node --test tests/unit/main-process/biz-op-v327.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/main-process/biz-op-v327.test.js tests/unit/main-process/background-execution/carrier-observation.test.js tests/unit/main-process/toolbox-background-generation.test.js
npm run release-check
```

## 兼容与验收边界

- 未修改 StartupRecoveryCoordinator、RecoveryControl、ServiceHost 恢复核心接口/语义；新业务入口及尚未实现的 export/upgrade 权威保持拒绝或受保护的未决状态。
- 原件 READY 与 PREPARE 同事务，目录/版本/引用/收据同连接提交；历史输入删除后的 RESULT 原件仍保护。
- 当前可用性从目录单独回读；实际导出前的文件完整性、Publisher 与大文件封存性能在 PR2/PR4 落实。
- Windows 本地未运行；目录持久化复用既有 durable-file 能力，宿主不支持目录屏障时必须拒绝。不能以 macOS 或注入时钟结果声称 Windows 可启用。
- 未操作用户业务文件、旧月份侧库、发布版本；未运行目标 400万/1400万数据规模、Excel/WPS 打开或人工资金验收。

## 远端 Windows 首轮与修正

PR #231 首轮 run `34011443931` 的 Windows 单元阶段失败，新增成功路径实际遇到 `DURABILITY_BARRIER_UNAVAILABLE`。这是该宿主目录 fsync 不支持的直接证据；Windows 新功能仍不可启用。

据此补充首次写入和同名文件重试的真实拒绝测试，修复同名文件内容相同即提前返回、可能绕过未确认屏障的问题；文件及所有 userData 内父目录均重新确认持久化。后台平台核心与 unsupported 语义不变。

需要真实目录屏障的 24 项测试在不支持宿主上明确标 SKIP，保留 3 项无此依赖的测试及新增拒绝测试。增加 Ubuntu / Node 22 CI 执行完整 BizOP 成功和故障路径，执行前必须探明屏障 supported。Windows 的 SKIP 不计为功能 PASS，也不替代 PR6 的能力门禁。

修正后本地 PR1b 专项：28 PASS / 0 FAIL / 0 SKIP（46.0 秒）；Windows workflow 契约：5 PASS / 2 个既有平台 SKIP / 0 FAIL；eslint 与 diff check 通过。该次未重复完整 release-check；远端修正运行待完成。

第二轮 run `34013070475`：Ubuntu 实际目录屏障及 BizOP 合同 job 成功；Windows 单元 6964 PASS / 27 SKIP / 1 FAIL。唯一失败来自同名文档重试用只读句柄 fsync，Windows 返回 EPERM，尚未到目录屏障拒绝断言。现改为用可写句柄重新同步自有不可变文档，字节不修改；候选原件只读副本和实际目录屏障要求保持。补充句柄权限断言，在 macOS 上也能捕获该 Windows 调用前提。

最终修正本地 PR1b 全文件 28 PASS / 0 FAIL / 0 SKIP（48.0 秒），eslint/diff check 通过。远端 Windows 需要对最新提交重新验证，不能将 Ubuntu 成功写成整个 workflow 成功。
