# v3.2.9 VCC 独立复审

日期：2026-09-19。只读快照：`/private/tmp/v329-release-20260919-3_bafjvz/review-snapshot`，父任务提供边界为 release `6bd55efe` 加 18 项未提交覆盖；本审查未改产品代码，未接触用户业务数据。

结论：本次已读代码及独立真实 Main 导入探针未发现新的可复现 P2+ 缺陷；上轮 FilePlan 元数据初次附加阻塞在当前快照已修复。**这不是完整验收通过：Spec AC30/RV12 和 TechDoc §12.4 明确要求的 Windows/Excel/WPS/完整 PF01–PF05 仍缺实际证据，因此不能据此签署正式发布通过。** 项目完整门禁由父任务统一执行，本报告不重复计数历史通过项。

## 本轮独立执行证据

命令：`node /private/tmp/v329-release-20260919-3_bafjvz/vcc-review/main-import-probe.js`，exit 0。源码 [main-import-probe.js](probes/vcc-main-import.js)，原始结果 [main-import-probe.txt](vcc-main-import.txt)。

该探针直接提取并执行快照 `src/main.js:15491` 开始的实际 import IPC 注册源码，Electron 文件对话框/窗口和操作跟踪为夹具；真实 Service inspect/revalidate/import Worker、FilePlan 预分配、Archive Controller settle/持久化和真实磁盘 SQLite 均执行。它不是完整应用冷启动或原生对话框验证。

- 1 个混合工作簿含充值和甲/乙两个通道 Sheet；结果 physicalFileCount=1、businessSheetCount=3，充值 1 行、通道 2 行，两个通道主体分别正确。
- 同一原件只登记 1 个 ready artifact，初始 aliasKey/sourceSnapshot/expectedSha256 保留；VCC 成员为 2 个类型、独立 hold 为 2 个。
- 永久删除 preview 返回 `ARCHIVE_BATCH_BUSINESS_HELD`，外部输入字节不变。
- 关闭服务及连接后重新打开，仅读持久 metadata 恢复 2 个来源，failed=0；删除夹具的充值有效事实并协调后只释放对应 hold，剩余 1 个 hold，冻结成员仍为 2。
- 初次探针清理使用了不存在的 service.close，已修正为真实 terminate API 后复跑成功；该错误是探针错误，不是产品缺陷。

## Requirement / evidence matrix

下列现有测试列表示当前快照中已核对的验收落点，**不代表本子任务重新运行过这些测试**；父任务全量门禁结果应另附。

| 要求 | 当前实现证据 | 自动化证据落点 / 本轮结论 |
|---|---|---|
| AC01–09、RV01–04 多 Sheet、混合类型、主体、失败统计、冻结恢复 | `src/main.js:15491`；`src/backend/vcc-financial-op/workbook-import-plan.js:71,142,183`；`import-service.js:177`；`src/main-process/vcc-financial-op-archive-lineage.js:62,222` | `tests/unit/backend/vcc-financial-op/multisheet-import.test.js`；本轮 Main 探针真实跨层 PASS。所有崩溃断点仍需结合全门禁。 |
| AC03/25、RV03/04 原件共享及独立 hold | `import-handoff.js:50,112`；`import-service.js:177`；lineage `:222` | `vcc-financial-op-archive-lineage.test.js:208,358`；本轮重开连接/释放单个来源/阻止永久删除 PASS。 |
| 上轮修复：FilePlan metadata 初次附加且不可改写 | `src/backend/database/archive-repository.js:2518` 将 4 个 FilePlan 身份键与 VCC 冻结成员隔离；不允许 patch 改写身份，已有业务 metadata 要求完整等值 | `vcc-financial-op-fileplan-handoff.test.js:63,101,123,133`；当前含 expectedSizeBytes 负例；本轮真正 Main beforeStart→settle→import PASS。 |
| AC10–15、RV13 全主体十四列、调整/汇总、归零仅 Sheet1、版本批注 | `src/shared/vcc-review-projection.js`；`review-export-plan.js:120`；`src/main-process/vcc-financial-op-review-writer.js:39` | `vcc-financial-op-review-export.test.js:19,65`；renderer 专项；本轮代码核对，未做人工页面/Excel 对照。 |
| AC16–20、RV05/07/08/09 差异来源身份、历史结构、独立 E/A/X、精度与类型 | `review-export-plan.js:120,292,338`；`review-export-contract.js`；`vcc-financial-op-review-validator.js:148` | review-export `:93,116,152,186,221,257,273,296,313`，legacy-error `:58,73,90,100,115`；检查坏绑定不回退历史路径。 |
| AC20/RV09 公式注入防护 | Writer 将原公式写缓存值/文本；validator `:109,118,139` 拒绝公式、外链及未预期外部内容；类型/格式另核对 | 上述 export/legacy 用例覆盖公式缓存、文本等；本轮未发现由合并引入的宽松绕过。 |
| AC21–23、RV06/11 互斥、只读、旧快照拒绝、目标保护 | `src/main-process/vcc-financial-op-service.js:1050–1158` 实际租约和两阶段 Worker；target `:19,54` 及同步发布；Main `:16008` 使用已存在服务 | review-ipc `:33,109,121,138,158,167`，review-target `:18,46`；最终核验到 rename 不异步让出；待确认导出无正式文件批次。 |
| AC26/RV10 存储 v3 迁移与旧连接 | `src/backend/vcc-financial-op-db/storage-upgrade.js:12` 专用升级连接/关闭/重新验证；storage-contract guard | 存储迁移、旧连接、generic/dedicated/COW 专项在统一门禁；本轮核对不复用不确定能力连接。 |
| AC27–29 真 ASAR 模板及既有正式导出 | `result-template-contract.js:155`；Main `:22005` 保留 publication-only owner completion；Review 为 support-action | `scripts/vcc-financial-op/verify-review-electron.js`，正式 writer/service/Archive 集成；现有脚本原生 SaveAs 为 stub。 |
| AC30/RV12/PF01–05 | Spec `:413,432,439`；TechDoc `:1054–1071,1128` | **未完成**：历史组件百万行和小样本 Electron 不能替代完整固定 Windows 基线。 |

## Actionable findings

本轮没有新增已复现产品 P2+；不将待执行平台验收凭空归类成代码 bug，也不把“未发现”写成所有功能已证实无缺陷。发布验收缺口见下，必须由发布负责人保留为未完成项。

## 明确门禁与最小补齐路径

Spec AC30（413 行）要求 Windows 安装版、Excel/WPS、百万级实际记录；RV12（432 行）引用 TechDoc §8.3/§12.4，Spec 417 行明确与 AC 一起验收。TechDoc 1054–1071 行固定 Windows x64、16 GiB、SSD、本地同卷、Electron 36.9.5、ExcelJS 4.4.0，同一机器/构建/启动条件；其他平台只能补充。1128 行明确尚不能标全部验收通过或已发布。

| 门禁 | 必须执行的自动部分 | 必须保留的人工/环境边界 |
|---|---|---|
| PF01 | 10 万/100 万固定文件数、主体数、差异坐标、结构与 Sheet 数；唯一长编号/高基数文本、Pending 双币种；真实 E/A/X；导出 Worker RSS 增量 ≤256 MiB及绝对峰值 | 固定 Windows 机器及真实依赖。worker_threads 与 Main 同 PID，process.memoryUsage().rss 是进程总 RSS，不能伪作独立 Worker RSS 或重复相加；缺可靠归因必须 NOT_RUN/明确缺口。 |
| PF02 | 单组 1,048,576 数据行加正常组；回读 1,048,575+1，两页表头、身份/顺序守恒且普通组存在 | 不能用现有 1,048,580 组件样本代替完整业务链路。 |
| PF03 | 200 主体、≥500 有数据附页、10,000 已保存调整；长名称、批注、引用；生成与回读、元数据观测 | Excel/WPS 人工核对仍单独未执行，不能从 XML 回读推断已完成。 |
| PF04 | PF01 百万行输出限速 1 MiB/s+暂时停写；观测 SheetStream、ZIP、文件队列、SST/行缓冲、上游停止与恢复无丢行 | 共享 writer createOutput 可在测试包装注入，但生产 Review writer 未暴露该选项；无观测就不得报告完整 PASS。 |
| PF05 | 准备/提取/写入/回读逐阶段取消；写入覆盖 drain+停写；最终保护发布时完成提交/回滚 | 记录 cancel request/收到/停止读取/关闭/清理/UI解除各时间；未插到真实阶段的用例不能冒充。 |
| AC30 及 §12.4 Windows安装版 | 真实安装包，正式/待确认导出、中文/长路径、覆盖/占用 | 原生 SaveAs、Excel/WPS 版本及人工对照记录；Node/macOS/Electron stub 对话框不替代。 |

可复用：`tests/helpers/vcc-review-export.js` 的真实导入、计算与请求准备；`scripts/vcc-financial-op/verify-review-electron.js` 的隔离 Electron/Service/Worker/ASAR 及证据输出；`measure-shared-writer.js` 的流式大样本生成/回读方式；`vcc-financial-op-review-ipc.test.js` 的取消/目标/只读断言；`bounded-xlsx-writer.test.js` 的慢写/背压注入。

建议最小新增验证 runner：以生产 Service 和原始 Review Worker 为执行入口，在验证专属 workerFactory 包装中安装观测，不重写业务算法；大样本由流式写入构造后经真实导入/计算。每次独立子进程保持基线一致，500 ms 保存原始过程采样、构建 SHA/平台依赖、输入输出身份和 E/A/X/readback 结果。没有专用 RSS/队列/阶段 hook 的地方输出 NOT_RUN 及缺口，不能将组件结果自动升级为 PF PASS。后续新增 runner 是独立实现任务，不改变本只读复审结论。


> 本报告保留审查快照时的结论。后续文档修复及最终组合验证以 [总审查](../release-review-2026-09-19.md) 和 [发布记录](../release.md) 为准。
