# Spec｜v3.2.10 仓储、执行编排与纯校验分离（G6）

| 项目 | 内容 |
| --- | --- |
| 目标版本 / 治理优先级 | `3.2.10` / P2；B0 worker 退出收口子项为 P1 |
| 计划功能分支 | `codex/v3.2.10-storage-execution-separation`；已创建，当前代码状态见实施记录 |
| 集成分支 | `release/v3.2.10`；基线复核与集成要求见[总索引](../../README.md) |
| 代码与开发起点 | 正式附注标签 `v3.2.9`，`main@11086a3cbf632a30adbcfa796e4cd81810c5aef9` |
| 日期 / 修订 | 2026-09-20 / v2（独立审查 R5 修订） |
| 状态 | v2 设计 + 用户已确认的 B3 锁归属补充；实现/验证/集成状态见 [实施记录](implementation-notes.md) |
| 配套 | [TechDoc](techdoc.md)；[审查 G6](../../../architecture-coupling/2026-09-20/review.md) |

## 1. 用户要求与工程决策

用户要求将耦合治理按功能分支写成可执行 Spec/TechDoc，说明“负责人”如何落实为模块。本项分成两个独立阶段：A 提取 VCC 映射血缘纯校验；B 将 Acquiring 多 worker 编排从仓储搬到应用 service。B 阶段先以 B0 修复核实出的 worker 退出收口缺口，再进行职责迁移。A/B 属于同一治理分支，分切片验收。

| 决策 | 本稿固定设计 |
| --- | --- |
| D1 | VCC 新增同域 `content-hash-contract` 与 `mapped-lineage-contract`；后者不经 row-mapper 间接加载 XLSX。 |
| D2 | 保留当前哈希版本、输入归一化和错误文案；不对历史数据重新计算或重写 hash。 |
| D3 | Acquiring service 拥有 worker 调用和失败后的清理编排，repository 拥有 SQL 计划和数据库操作。 |
| D4 | 保留“逐 chunk 合并事务 + 失败后按 run 清理 + partial/resume”的现有合同，不改成全批原子提交。 |
| D5 | 生产 session 切换为应用 service；仓储不保留 worker wrapper 或注入 executor 后门。测试显式装配 service，清点调用完成后删除旧仓储导出。 |
| D6 | B0 修复部分初始化失败及 terminate 后提前返回；只有确认本组所有已创建 worker 退出，才允许结束阶段的 part 清理和向上结算。该项是本稿明确增加的行为修复，不伪称基线已有保证。 |
| D7 | 保留固定 tempDir 跨 run 复用及 C1 写前重建合同：可信 Main 调用方授权的受管 part 命名空间允许重建历史残留；调用者外层目录、无关文件和其他 run 的数据库 diff 不在该授权内。不得仅凭文件名匹配判断归属，不改为新 run 子目录。 |
| D8 | 2026-09-20 用户确认 B3 最小锁修复：删除 Main pool failureListener 的无归属全局解锁，run/resume 的所属 prepare release closure 继续经 execute finally/onAbandon 释放；旧 idle worker 失败不得解下一 prepare 的锁。不改变 pool 调度协议，具体范围见[补充方案](b3-lock-fix-proposal.md)。 |

## 2. 设计基线已核实的现状

- [review-export-plan.js:17](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/review-export-plan.js:17) 为 `assertMappedLineage` 依赖完整 dataset writer；校验与旧版本重建在 [writer:666](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/vcc-financial-op-dataset-writer.js:666)。
- [row-mapper.js:3](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/vcc-financial-op/row-mapper.js:3) 同时包含 hash 与日期/金额映射，经 normalizers 载入 `xlsx`；仅搬校验函数却继续依赖 row-mapper 不能形成纯依赖闭包。
- [Acquiring repository:422](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/backend/acquiring-bill-currency-db/run-repository.js:422) 实现多 worker wrapper，并反向 require 执行器；[session:784](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/acquiring-bill-currency-session.js:784) 又负责资源参数与状态推进。
- [executor:151](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker.js:151) 按 chunk 单独事务合并。中途失败可能已经写入部分 chunk，后续清理也可能失败；当前不是“失败必然零残留”。

- [worker 写前重建:137](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker-worker.js:137) 会删除即将写入的 `part-<chunkIndex>.sqlite` 及 `-wal/-shm/-journal`，避免跨 run 残留追加污染；[C1 回归:568](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/tests/unit/main-process/run-check-multiworker.test.js:568) 明确保护这一合同。Main 传入的固定目录来自 [storageRoot/.mw-tmp:17615](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main.js:17615)，不是用户选择的任意目录。
- 新增核实：同一 executor 的 [初始化:96](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker.js:96)、[关闭:135](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker.js:135) 在 terminate 后提前 reject/resolve；[并行启动:318](/Users/pzhong/Desktop/Project/bank-bill-excel-tool/src/main-process/run-check-multiworker.js:318) 的整体赋值可能遗漏已经启动的 worker。此处现有 Promise 完成不等于真实退出。

## 3. 阶段 A：VCC 校验行为

输入为当前映射结果与存储血缘，成功无返回值，失败沿用 `archive-row-integrity-failure`。用户入口、预览和导出结果不增加字段或提示。

| 输入 | 必须保持的结果 |
| --- | --- |
| 普通明细 hash v2 / Pending hash v3 | 比较映射后的 contentHash 与存储 hash |
| 普通明细旧 hash v1 | 按旧 contentHash(sourceType, rawJson, subject) 重建 |
| Pending 旧 hash v2 | 按原 rawContractVersion 与 canonical values 重建 |
| CHANNEL | 保留 assignedSubject 去首尾空白后参与 hash 的现有规则 |
| 未知 hash 版本 | 沿用现有未知版本错误，不能自动按最新版本解释 |
| disposition 非空、幂等键或 hash 不等 | 沿用原完整性失败及中文明细，不跳过不一致行 |
| Pending v1/v2 原始列合同 | 保留各版本字段数量检查及映射顺序，不改当前金额/币种规范化 |

当前 `HASH_VERSION=2`、`PENDING_HASH_VERSION=3`；本项不升 hash、raw contract 或输出 schema 版本。公共导出函数的位置兼容可暂时保留，实际校验只执行一次。

## 4. 阶段 B：Acquiring 执行行为

单 worker、多 worker 的 diff 行内容与物理顺序必须与基线相同。多 worker 仍从 reader part 按 chunkIndex、seq 顺序合并，业务 JOIN 和币种差异判定不改。

| 场景 | 必须保持的行为 |
| --- | --- |
| 0 行 | 返回 0 chunks / 0 processed / 0 inserted / lastCompletedChunkIndex=-1；不启动 worker |
| worker 数多于 chunk 数 | 沿用现有有效 worker 数收敛逻辑 |
| reader 完成 | 只产生原 progress；不能据此标为已提交或完整成功 |
| 全部 reader 成功 | 才开始逐 chunk 合并；正常结束返回原汇总 shape |
| reader、merge 或取消失败 | B0 确认本组全部已创建 worker 退出后抛原错误；service 再按原逻辑尝试清理该 run |
| 部分初始化失败 / postMessage 失败 | 保留所有已创建 worker 的所有权；停止本组新派发，逐一关停并等待退出，不遗漏尚未 init-done 的 worker |
| close 超时 | 5 秒仍是优雅关闭期限，超时触发 terminate；不把发出 terminate 当完成，不新增强制退出成功的时间承诺 |
| terminate 失败且尚未观察到 exit | 记录关闭错误并继续持有本组资源，等待 exit；不提前清目录、释放调用链或标成功 |
| 失败清理也失败 | 保留原始失败，由 session 按原合同标 partial；不得宣称零残留，不以成功覆盖原失败 |
| 崩溃后 resume | 保留从 chunk 0 清理后单 worker 重跑的既有路径 |
| 受管旧 part | 同一受管目录在前次调用已经退出或进程已结束后顺序复用；写每个 chunk 前重建其精确 part 路径及 SQLite sidecar，保留 C1，旧行不得进入本次结果 |
| 临时目录及无关文件 | Main 证明目录来源和受管命名空间授权；执行器仅处理本次派发的精确 part 路径，不能 glob 清整个目录。session 仅删除自己创建且独占的外层 tempDir；caller 外层目录和其中未授权文件保持不变 |
| 同 tempDir 并发 | 不支持两个活跃调用共享同一 part 命名空间。Main 调用方必须在前次真实退出及结束清理后才复用；本次不新增并发能力，不把另一活跃调用的 part 视为历史残留 |

除 B0 明确修复的退出顺序及 D8 已确认的 Main 锁归属修复外，参数验证、批次上下文冻结、cancelToken、初始化/优雅关闭超时的有效值保持基线；不以本项重构引入新队列或并发模式。

## 5. 范围、依赖与兼容

本项不改数据库 schema、导出文件格式、业务算法或 persistent state enum。不合并 G4 的解析器设计，不搬全部 financial-decimal/normalizers，不扩展归档删除权限。G8 引用本项纯模块路径施加边界检查；本项可独立实现，不依赖 G4 先完成。

G4/G6 若并行修改 VCC reader/writer，按函数级职责合并，保留本项新增纯合同与 G4 的读取资源清理。任何旧 wrapper 的移除均须完成全仓调用方清点，不删除冻结基线之外仍有调用的接口。

## 6. 验收条件

| 编号 | 验收条件 |
| --- | --- |
| G6-AC-01 | 新纯校验模块及其本地依赖闭包不加载 writer、xlsx/exceljs、文件系统、SQLite、worker 或 Electron。 |
| G6-AC-02 | 普通 v1/v2、Pending v2/v3、raw contract v1/v2、CHANNEL 主体与未知版本的结果/错误与基线一致。 |
| G6-AC-03 | writer 与 review plan 复用同一校验实现，旧兼容导出仍可调用且不重复执行。 |
| G6-AC-04 | 仓储中不再 import/call worker 宿主；SQL 计划与数据库清理由明确仓储接口提供。 |
| G6-AC-05 | 0/1/多 chunk、不同 workerCount 的 diff 内容、物理顺序及汇总结果与基线相同。 |
| G6-AC-06 | 取消、reader crash、merge 中断、cleanup 失败保持原错误/partial/resume；B0 使 init 部分失败、close 超时/发送失败也等待本组真实退出，退出前不做结束阶段的 part 清理/结算。 |
| G6-AC-07 | caller 外层 tempDir、未授权文件及其他 run 的数据库 diff 保持不变；经可信调用方授权、独占使用的受管 part 命名空间仍保留 C1 跨 run 写前重建，旧行不得污染新结果。相同目录只顺序复用；结束清理等待 B0 真实退出，不能以路径或文件名存在扩大删除权限。 |
| G6-AC-08 | 迁移后生产路径只有一次执行/结算，无 schema 迁移；整阶段回退可恢复旧调用链。D8 补充：idle pool failure 不解其他 prepare 的锁；run/resume 正常、active failure、取消经所属 finally 释放，onAbandon 与旧 owner 重复释放不清下一 prepare 的锁。共享 prepared 包装器的独立基线异常路径另列验证边界。 |

## 7. 交付阶段

A1 锁定 hash/version fixture → A2 提取纯合同并保留旧导出 → A3 切换 review plan/writer；B0 先完成退出收口修复及反例回归 → B1 锁定 SQL/多 worker/失败基线 → B2 提取计划和 service → B3 切换 session、移除仓储反向依赖。各阶段只以其测试范围宣告完成，正式交付门禁与平台验收见 TechDoc。

本次文档补充统一交付要求：每个切片均按[切片完成标准](../../README.md#slice-completion)验收，并按[实施记录与状态要求](../../README.md#slice-record)区分本稿设计 AC、实际实施进度与已取得的验证证据；本补充不改变上述业务验收条件。
