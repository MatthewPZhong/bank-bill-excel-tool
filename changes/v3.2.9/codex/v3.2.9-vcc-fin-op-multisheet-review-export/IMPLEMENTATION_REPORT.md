# v3.2.9 VCC 分支实施记录

| 项目 | 结果 |
| --- | --- |
| 日期 | 2026-09-19 |
| 分支 | `codex/v3.2.9-vcc-fin-op-multisheet-review-export` |
| 起点 | 本地 `main`，`2ba9ef14fe972363b604955636cff0c9ac53700f` |
| 需求依据 | [Spec R3](v3.2.9_VCC_Spec.md)、[TechDoc R3](v3.2.9_VCC_TechDoc.md) |
| 代码状态 | 已实施，工作区未提交；未推送、未发布，应用版本保持基线 `3.2.8` |
| 验收状态 | 第五轮 178 项专项及完整 release-check 通过；此前 Electron/ASAR、共享 Writer 百万行测量保留为历史证据；Windows/Excel/WPS 与完整 PF 验收待执行 |

首次外部评审的五项 P2 已完成修复，144 项专项检查与完整 `release-check` 通过，见 [评审修复记录](REVIEW_FIXES.md)。随后复审发现的富文本回归和系统 OP 布尔核验问题已修复，168 项专项及完整门禁通过：单元 7,351 通过、3 项 Windows 专用跳过；53 个集成脚本、2,488 项断言通过。第二轮证据见 [复审修复记录](REREVIEW_FIXES.md)。第三轮新增的 SST 目录误删和历史系统 OP 错误值兼容问题已修复，240 项专项及完整门禁通过：单元 7,378 通过、3 项 Windows 专用跳过；53 个集成脚本、2,488 项断言通过，见 [第三轮修复记录](REVIEW3_FIXES.md)。

第四轮确认并修复系统 OP 显示主体误拒绝、主体 `CNH` 被套用币种兼容、失败 Sheet 已读行数丢失三个问题。178 项专项及完整门禁通过：单元 **7,389 通过、3 项 Windows 专用跳过**；**53 个集成脚本、2,488 项断言通过**；门禁后 65 个相关文件指纹全部匹配，见 [第四轮修复记录](REVIEW4_FIXES.md)。

第五轮修复系统 OP 关闭 Reader 期间收到取消后仍提交快照的问题：关闭后复核取消，停止当前尚未提交的组及后续工作，保留已提交组。178 项专项及完整门禁通过：单元 **7,394 通过、3 项 Windows 专用跳过**；**53 个集成脚本、2,488 项断言通过**；门禁后 65 个相关文件指纹全部匹配。最新状态及证据见 [第五轮修复记录](REVIEW5_FIXES.md)。下文原始测试数字与样本保留为首次实施证据。

## 1. 已实施行为

- 导入按工作簿逐 Sheet 预检，显示文件、Sheet、顺序、隐藏状态、表头位置和诊断；说明页需明确排除，坏业务表不能绕过。通道主体按 Sheet 绑定；系统 OP 各 Sheet 独立验证九币种快照。
- 物理文件、业务 Sheet 和实际读取行数分别统计；页面进度覆盖预检、指定文件/Sheet 读取、类型组校验写入及汇总。系统 OP 的读取行数与主体快照数量分开。
- 存储合同升级至 v3；一个混合工作簿可绑定多种业务来源，同类型多 Sheet 共用来源。先持久化成员与原件、建立各来源 hold，再按既有事务提交事实；历史身份与 v1 COW 流程保留。
- 确认页增加“导出待确认表”，无主体选择；全部主体写入一个工作簿的 `待确认表`，十四列、明细/调整及四类汇总与页面共用投影。
- 差异附页按当前生效差异、有效事实身份、原始结构及原 Sheet/行提取；Pending 支持双币种关联和组内身份去重；48/46 列历史结构分开保留。
- 从 Biz OP 抽取共享有界 Writer，保留其原输出合同；VCC 负责富表格、批注、调整引用、分页与 E/A/P/X 校验。明确文本/数值类型，避免长编号、前导零和高精度值失真。
- 接入 Main/preload/renderer IPC、原生另存为、任务互斥、可取消等待、目标保护、同步最终核验与发布/回滚。待确认导出不改结果、输入、调整、归档或正式批次。
- 数据管理结果 `calculated` 显示“待确认”，`archived` 显示“已归档”；原表和校验表状态语义不变。
- 内置模板每次读取同一 Buffer、验证固定 SHA-256 后解析和缓存；不再以 ASAR inode/时间戳作为稳定身份。

结果模板 SHA-256 保持：`48c8161484128e63a6e3e60724336f2433a8f23687695d980720c59a9dec2053`。

## 2. 主要实现位置

| 内容 | 文件 |
| --- | --- |
| 预检和私有导入计划 | `src/backend/vcc-financial-op/workbook-import-plan.js` |
| 显式 Sheet 读取及导入 | `workbook-reader.js`、`detail-importer.js`、`system-op-importer.js`、`import-service.js`（同上目录） |
| 存储合同和迁移连接 | `src/backend/vcc-financial-op-db/storage-contract.js`、`storage-upgrade.js`、`src/backend/database.js` |
| 持久成员与来源恢复 | `src/backend/vcc-financial-op/import-handoff.js`、`src/main-process/vcc-financial-op-archive-lineage.js` |
| 页面/Sheet1 投影 | `src/shared/vcc-review-projection.js`、`src/renderer-vcc-financial-op.js` |
| 独立期望、提取与历史原值 | `src/backend/vcc-financial-op/review-export-plan.js`、`review-export-contract.js` |
| 共享 Writer 与 Biz OP 适配 | `src/main-process/bounded-xlsx-writer.js`、`src/main-process/biz-op-v327/export-writer.js` |
| Review 编排、Worker、回读 | `src/main-process/vcc-financial-op-review-{writer,worker,validator}.js` |
| IPC、任务与目标发布 | `src/main-process/vcc-financial-op-review-{ipc,target}.js`、`vcc-financial-op-service.js`、`src/main.js`、`src/preload.js` |
| 模板修复 | `src/backend/vcc-financial-op/result-template-contract.js` |

## 3. 专项与故障验证

使用真实 SQLite、临时 XLSX 和生产 Worker。测试 fixture 全部使用独立临时目录，没有打开或迁移用户的业务数据库。

- 存储：真实 v2 数据增量迁移、各持久断点回滚、提交后失败如实报告已形成 v3、旧连接写阻断、坏 guard/索引/未来版本拒绝、generic/dedicated mutation 与 COW 回归。
- 导入：同类型多 Sheet、混合类型、按 Sheet 主体、跨 Sheet 幂等、隐藏/空白/未知及坏表头、快照完整性、原行追溯、同字节文件替换导致计划失效。
- 来源：一个 artifact 多来源和独立 hold；同名同内容的不同输入在存档共用 Blob 后仍保留两个来源并做幂等；绑定损坏不能被 fallback 掩盖。
- 导出：全部主体、手写预期附页身份、调整归零只剩 Sheet1、再出现差异恢复对应附页、历史 Pending 48/46 列保真、输出的金额/样式/隐藏附页篡改拒绝。
- 只读性：在业务数据库所有业务表加禁止 INSERT/UPDATE/DELETE 的触发器，覆盖真实 handler → Service → 两阶段 Worker 的成功、取消和强制退出。
- 发布：SaveAs 期间或 Writer 期间结果/输入变化、目标替换、受保护路径拒绝、同步 freshness 与 rename 之间没有微任务让出、发布失败恢复旧文件、恢复失败保留文件并提供路径。
- 清理：取消后临时资源清理失败必须报错和返回残留路径，不能假报“已取消”；慢输出、drain 等待、提前关闭、磁盘错误和取消结束等待均有专项。

首次实施的最后一轮相关专项命令（52 个测试通过）：

```bash
node --test \
  tests/unit/backend/vcc-financial-op/multisheet-import.test.js \
  tests/unit/main-process/vcc-financial-op-review-export.test.js \
  tests/unit/main-process/vcc-financial-op-review-ipc.test.js \
  tests/unit/main-process/vcc-financial-op-review-target.test.js \
  tests/unit/main-process/vcc-financial-op-archive-lineage.test.js \
  tests/unit/renderer-vcc-financial-op.test.js
```

以上是专项计数，不与全量门禁重复累加。[专项原始输出](evidence/final-targeted.txt)，[首次实施源文件指纹](evidence/source-fingerprint.json)。重要变量关联检查见 [CHECK_VARS.md](CHECK_VARS.md)。

## 4. 工程门禁（首次实施记录）

```bash
UNIT_TEST_CONCURRENCY=2 npm run release-check
```

首次实施的完整执行返回 **exit 0**；当时源码与 [指纹清单](evidence/source-fingerprint.json) 一致。

指纹采集时检出记录为同一基线的 `main`；交付前已切回上表指定的功能分支，59 个实现与测试文件的内容哈希全部一致。证据保留采集时与交付时的分支字段，未把切换分支计为代码变更或重新测试。

| 检查 | 结果 |
| --- | --- |
| lint | PASS |
| smoke | PASS |
| 单元 | 7,325 通过、0 失败、3 跳过；共 7,328 项、831 个 suite、475 个文件 |
| 集成 | 53 个脚本、2,488 项断言全部通过 |

3 项跳过均为 Windows 专用的 PowerShell 清理/packaged canary 测试。完整 [原始输出](evidence/release-check.txt) 和 [结构化结果](evidence/release-check-summary.json) 已保存；集成 runner 已同步 `rules/integration-test-policy.md`。单元与集成耗时分别约 735 秒、490 秒，属于本机此次执行记录。

## 5. 真实 Electron / ASAR

执行脚本：`node scripts/vcc-financial-op/verify-review-electron.js`。

[原始结果](evidence/electron-review-evidence.json) 和 [执行日志](evidence/electron-review.txt) 使用真实 Electron `36.9.5`、Node `22.19.0`、ExcelJS `4.4.0` 和实际创建的 `app.asar`：

- 同一个 ASAR 模板两次 stat 的 inode 从 `1` 变为 `2`，内容加载和缓存仍通过；篡改模板继续拒绝。
- 隔离 BrowserWindow 通过项目真实 preload、生产 IPC handler、Service 和两个实际 Worker 导出成功：2 个主体、15 张 Sheet、14 条原表附页记录；结果仍为 `calculated`。
- 随后在隔离业务库确认归档，并使用 ASAR 内的结果模板和 Pending 辅助模板完成两个主体的正式结果导出，回读通过。

原生 SaveAs 在该脚本中使用受控返回值；脚本没有代替人工原生对话框、完整 Main 冷启动或 Windows 安装版验收。JSON 中的运行时临时路径用于记录当时执行位置，临时目录已清理，保留下列样本供查看：

- [全主体待确认表](evidence/待确认表.xlsx)
- [甲正式结果](evidence/甲-正式结果.xlsx)
- [乙正式结果](evidence/乙-正式结果.xlsx)

## 6. 百万行组件测量

执行脚本：`node scripts/vcc-financial-op/measure-shared-writer.js`。

[原始结果](evidence/shared-writer-1048580.json)，环境为 macOS / Node `24.13.0`。这是共享 Writer 与流式 Reader 的组件测量，未经过完整 VCC E/A/P/X、Main 进程采样或 Windows 环境。

| 指标 | 实测 |
| --- | ---: |
| 数据行 / 列 | 1,048,580 / 49 |
| 分页数据行 | 1,048,575 + 5 |
| 回读数据行 | 1,048,575 + 5，逐行值和列数一致 |
| 写入耗时 | 63.2 秒 |
| 回读耗时 | 215.6 秒 |
| 采样峰值 RSS | 248,168,448 字节，约 237 MiB |
| 输出大小 | 169,334,061 字节，约 161.5 MiB |
| 聚合流队列观测峰值 | 162,333 字节 |
| drain 等待次数 | 32,712 |

测量完成后删除本次生成的大样本临时文件，仅保留结果 JSON。该记录不标记 PF01–PF05 通过，也不承诺固定导出秒数。

## 7. 待执行验收与交付边界

以下仍是未执行项：

1. Windows x64 安装版的原生另存为、覆盖确认、文件占用、中文路径和长文件名。
2. Excel/WPS 实际打开与页面对照；多主体、批注、样式、调整引用和打印范围的人工核对。
3. TechDoc PF01–PF05 的完整 VCC 链路测量，包括十万/百万规模对比、200 主体/500 附页/10,000 调整、1 MiB/s 慢盘、分阶段取消以及 Main/Worker 每 500 ms 内存采样。
4. 生产配置的完整冷/热启动和含 WAL 的人工备份恢复演练；独立代码复审。

本次改动包含存储 v3 迁移。升级后不能改回 v2 marker 或用旧程序写 v3；回退需使用支持 v3 的程序或既有维护备份恢复流程。当前没有提交、推送、发布或迁移用户业务库。不能把以上本地测试记录视为 AC30/RV12 或整版发布验收已完成。
