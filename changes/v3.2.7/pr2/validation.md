# PR2 验证记录

基线：PR1b `6fdde8c2`。仅合成工作簿和独立临时库；应用版本仍 3.2.6，新功能生产开关关闭。原 E5 包只读。

## 自动检查

| 检查 | 结果 |
| --- | --- |
| 公共 writer 核心 | 7 PASS；真实 SQLite、4096/4MiB 边界、外层事务、COMMIT/ROLLBACK 不确定状态 |
| 初轮含共享旧读取 / PR1b 聚焦 | 110 PASS / 0 FAIL |
| 最终 PR2 模块（补充故障测试前） | 20 PASS / 0 FAIL |
| Electron 专项（补充故障测试前） | 44 PASS / 0 FAIL / 0 SKIP；包含共享关闭与宿主 24 项 |
| 补充 COMMIT 反馈丢失后错误保留 | 系统 Node 导入专项 10 PASS；最终 Electron PR2 全模块 21 PASS / 0 FAIL / 0 SKIP |
| release-check 单元阶段 | 7009 PASS / 3 个既有 SKIP / 0 FAIL；共 7012 项，后补 1 项故障测试不假报已计入 |
| release-check 集成 / smoke / lint | 53/53 集成脚本、2488/2488 检查 PASS（454418ms），smoke/lint PASS；完整进程 exit 0 |
| eslint / diff check | 已通过，提交前复核最终差异 |

原始日志保存在本 worktree `outputs/pr2-validation/`。重复执行不累计成新增测试；最后一项 writer 错误保留修正仅影响本期首个调用者，追加当前完整 PR2 Electron 专项验证，未重跑全部旧模块集成。

真实主链覆盖 A+B→顺序变化复用→A+B′、相同原件重复选择、坏批保持旧 heads、独立报告登记、真实 worker 取消、三个动态账期封存后 Main 退出和未提交恢复、worker 退出后文件改变拒绝。取消由检测到实际行写入后发出，最终实际 carrier EXITED，扫描完整性和精确计数标记均为 false。

## 资源试验

`scripts/biz-op-v327/import-scale.js` 使用完整 28 列真实合成 XLSX、高基数中文/emoji 长账户 SST、相同流水单号（不业务去重）。Task/Archive/native worker/Main 提交均真实执行；每个试验是独立临时 userData，非真实应用数据。

| 项 | 100000 行 | 1000000 行 |
| --- | --- | --- |
| 运行时 | 系统 Node 25.8.0 | Electron 36.9.5 / Node 22.19.0 |
| 平台 | macOS arm64 | macOS arm64 |
| 合成文件生成时间 | 3385 ms | 32427 ms |
| 导入总时间 | 21571 ms | 192009 ms |
| XLSX 字节 | 8534211 | 86423465 |
| Main 定时器采样进程 RSS 峰值 | 569327616 B | 377782272 B |
| Main 20ms 定时器最大延迟 | 9 ms | 3 ms |
| 读取/写入阶段 | 20838 ms | 178119 ms |
| 索引 / 封存阶段 | 369 / 211 ms | 2826 / 10548 ms |
| 事务数 / part 数 | 33 / 1 | 328 / 4 |
| 活跃候选写连接峰值 | 1 | 1 |
| 事务计费峰值 | 4193951 B | 4193951 B |
| 初始 SST 计费峰值 | 33554315 B | 33554315 B |
| 磁盘 SST 缓存计费峰值 | 4268032 B | 4276224 B |
| 磁盘 SST cache hit / miss | 0 / 100000 | 0 / 1000000 |
| SST 临时磁盘 | 47288890 B | 473888890 B |
| 实际 carrier closed | true | true |

初始 SST 与磁盘 cache 上限分别为 33554432 B；不是将两者视为一个预算。长字符串双限、超缓存单条不缓存、随机读取、索引截断及关闭错误另有专项测试。此处两档 runtime 不同，不做性能倍率推断。RSS 为含 Main/原生线程/夹具的进程采样，未覆盖所有瞬时峰值，不能作为 V8/OS 的硬上限或完整 Electron UI 的峰值保证。

高频交错日期另以 100 行、两个日期、16 小分片验证：100 次实际候选连接与事务、活跃连接峰值 1、源行 2..101 全部守恒。T01 两路线的小中型精确结果及性能见 `t01-decision.md`。

## 明确保留

- Windows 目录持久化能力仍未满足；依赖该能力的成功测试在 unsupported 宿主明确 SKIP，由要求真实 supported 的 Ubuntu CI 执行。Windows 拒绝测试不等于 Windows 新功能可用。
- 未运行两端各 400 万 OP + 1400 万流水、Windows 大规模导入、Excel/WPS 实际打开或人工资金验收。
- 金额无法无损写 Excel 数值时用文本、19 列结果、描述冲突、Publisher、页面和升级启用分别在后续 PR 实施，本 PR 不宣称它们已完成。
- 基准后追加的变更为原始提交错误保留、Main 有界计数/诊断摘要复核；独立聚焦测试验证，不重写已经取得的基准数字。

## 复跑入口

```bash
npm run release-check
node --test tests/unit/backend/sqlite-candidate-writer.test.js tests/unit/main-process/biz-op-v327-import.test.js tests/unit/main-process/biz-op-v327-import-main.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --test tests/unit/backend/sqlite-candidate-writer.test.js tests/unit/main-process/biz-op-v327-import.test.js tests/unit/main-process/biz-op-v327-import-main.test.js
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/import-scale.js 1000000 FLOW --keep
ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/Electron.app/Contents/MacOS/Electron scripts/biz-op-v327/compute-route-probe.js 100000 32
```
