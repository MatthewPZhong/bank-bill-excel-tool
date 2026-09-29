# Spec｜v3.2.10 BizOP 查询与归档数据边界（G5）

| 项目 | 内容 |
| --- | --- |
| 目标版本 / 优先级 | `3.2.10` / P2（沿用治理清单排序，不作为事故等级） |
| 计划功能分支 | `codex/v3.2.10-bizop-query-boundaries`；未创建 |
| 集成 | `release/v3.2.10`；基线复核见[总索引](../../README.md) |
| 基线 | 正式附注标签 `v3.2.9`，`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 日期 / 状态 | 2026-09-20 / v1 设计；未实施、未执行测试 |
| 依据 / 配套 | [耦合审查](../../../architecture-coupling/2026-09-20/review.md)、[TechDoc](techdoc.md) |

## 1. 目标与事实边界

用户要求分功能分支落实查询所有权。本项使 BizOP 计算输入、导出对象、删除闭包和导入诊断的读取通过明确 query 接口完成，将归档内部表访问收回 archive repository。

这不是“目前没有锁或校验”的修复。当前计算在 admission.exclusive 内、导出在 admission.readTask 内、删除预览在同步 admission.read 内执行；generation、闭包摘要、hold 与 receipt 已存在。同域多个文件使用内部 catalog 本身不构成越权。本项优先修正跨归档表读取，再以小范围整理减少状态过滤的同步点，不把整个 catalog 重写。

证据：[compute-inputs:33](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/compute-inputs.js:33)、[export-inputs:11](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/export-inputs.js:11)、[delete-preview:54](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/delete-preview.js:54)、[catalog:387](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/biz-op-v327/catalog.js:387)。

## 2. 已锁定的工程决策

| 编号 | 设计 |
| --- | --- |
| D1 | 新增同域 catalog-queries，只负责查询与行投影；文件验证、指纹、闭包组装、admission 和状态写入留在现有责任模块。 |
| D2 | 新增 archive.hasOtherArtifactForBlob(blobId, artifactId) 的存在性接口，原样封装 LIMIT 1 SQL，避免改用全量列表产生无界分配。 |
| D3 | 保留 catalog.db 给尚未迁移的本域命令/恢复实现；本分支不全局封禁 SQL，也不改变事务层级。 |
| D4 | 流式来源/关联结果查询使用同步 iterator，让调用方在现有预算达到时停止；不先 all() 再检查。 |
| D5 | public IPC、快照 JSON 字段、顺序、错误码、删除模式和持久化版本不变。 |

## 3. 必须保持的行为

### 3.1 计算输入

按当前日期区间规则选择 ACTIVE head；缺少任一必需数据时返回完整 missing 清单并拒绝开始计算。数据来源仍校验 ready、hash、v327-input hold、rowCount 与 payload manifest。文档列表、BU/摘要排序、inputFingerprint 和 expectedGeneration 的生成保持原处和原算法。

### 3.2 导出

| 类型 | 读取条件与结果 |
| --- | --- |
| RESULT_* | 只接受 PUBLISHED run；起止端点版本必须恰好完整；columnSchemaVersion 依据已核验 manifest 决定 |
| ERRORS | 只接受 READY diagnostic，并关联 sealed manifest；保留 scanComplete/errorCountExact/sampleCount |
| OP_*/FLOW_* | 只接受 ACTIVE 且 kind 匹配的数据集 |
| *_RAW | 继续校验 artifact、hold、hash 和实际文件；不能因为查询成功省略源文件校验 |
| 不存在/已失效 | 沿用原 unavailable、metadata missing、contract mismatch 等错误；不自动回退到旧版本 |

### 3.3 删除预览与确认

返回仍为 schemaVersion=1 的 generation、selection、datasets、runs、references。引用统计保留“同一 Blob 的其他任意状态 artifact”，不能只统计 ready。锁、其他 owner hold、KEEP_RESULTS 与 DELETE_ASSOCIATED 计算规则完全继承基线。

保持预算：总选取数≤4096；闭包 charge 计数≤4096、字节≤49152；闭包序列化≤65536字节；预览响应≤131072字节。过期时间仍10分钟，未确认预览最多64个。确认继续检查 generation、完整闭包 digest、过期和复用；绑定仍要求 exclusive。

本项 query 不删除文件、不释放 hold、不更改任何删除资格。正在被其他有效批次或业务使用的受管文件仍受保护，外部原文件不进入删除范围。

### 3.4 导入诊断

恢复诊断时继续校验唯一 producer dispatch、report owner、manifest digest、实际样本文件与关闭证明。成功导入后的空诊断仍通过原维护动作回收，不在 query 返回空报告时直接删除。

## 4. 范围、接口与相邻治理

迁移范围锁定为 compute-inputs、export-inputs、delete-preview 的业务读取，以及 import-main 的 dispatch/diagnostic 读取；catalog 命令、diagnostic lifecycle 写入、recovery 和 delete-preview 本身的预览持久化命令不在本次强制搬迁清单。

新增 query 对象只在 Main 内装配，不暴露给 Renderer，不返回 DB/statement/transaction 对象。仍使用 catalog 同一个连接，不创建 side DB、只读副本、缓存或新事务。G2/G7 只改变调用装配，不重新定义本项查询结果；G8 的 `ARCH-BIZOP-QUERY` 对迁移完成的读取作用域施加限制，不把预览自有表的合法命令及附属读取判成违规，按 Q1–Q3 子边界逐项激活。

## 5. 异常与兼容矩阵

| 场景 | 结果 |
| --- | --- |
| exclusive 或 recovery gate 不允许访问 | 沿用现有 admission 错误，不由 query 再创建一次准入 |
| 相同数据、相同 generation | 新旧快照 JSON、fingerprint、错误及排序一致 |
| 查询过程中超预算 | 在原计数点失败，不返回前缀或部分预览 |
| 源文件在异步验证前后变化 | 原 hash/owner/manifest 检查继续拒绝，query 无缓存掩盖变化 |
| 预览后保护状态改变 | 即使 selection 相同也因完整 closure digest 改变而失效 |
| 新旧代码切换 | 无数据迁移；全切片回退，不能留下新调用与缺失query接口的组合 |

## 6. 验收条件

| 编号 | 条件 |
| --- | --- |
| G5-AC-01 | delete-preview 不直接读 archive_* 表，存在性语义与 LIMIT 1 有界读取保持一致。 |
| G5-AC-02 | compute-inputs 由 query 提供数据行/来源，冻结结果、预算及所有错误与基线一致。 |
| G5-AC-03 | 三类导出及 RAW 校验结果与基线一致，RESULT 的 manifest 版本判断未移走或省略。 |
| G5-AC-04 | 删除预览 JSON/digest、保护计数、预算、过期/复用/generation 检查保持一致。 |
| G5-AC-05 | 导入诊断读取迁移后仍核验 producer、manifest、关闭事实；回收路径保持原维护动作。 |
| G5-AC-06 | query 无写操作、无文件IO、无新连接/事务；原 exclusive/readTask/read 的范围与时长不变。 |
| G5-AC-07 | 同域未迁移命令可继续工作，catalog.db 的保留清单明确；ARCH-BIZOP-QUERY 拒绝读取协调器绕回 raw DB，允许预览表命令和附属读取；无schema、状态或公共API变更。 |
| G5-AC-08 | 所有迭代器按既有顺序消费、可在预算处停止；替换前后等价场景和负向场景均通过。 |

## 7. 阶段

先封装归档存在性查询；再接入 compute/export；最后接入 delete-preview/import diagnostic，完成边界检查。每阶段保留现有安全控制，不借整理同时更改删除或导入策略。实现任务和测试映射见 TechDoc。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充不改变上述业务验收条件。
