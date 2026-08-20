# v3.1.12 Preflight — 实施前未知项与证据

| 项目 | 内容 |
| --- | --- |
| 日期 | 2026-08-19 |
| 状态 | TechDoc 已确认；实施中 |
| 基线 | `ccfa71ffc92bb26bbf47c05efa87740d972cf209`（最新 `origin/main`；包版本已预置 v3.1.12） |
| 关联文档 | `spec.md`、`techdoc.md`、`implementation-notes.md` |

## Task Brief

- Goal：完成网银账单最终确认单次源文件比较、Windows 启动治理、VCC 新导入 CNH→CNY、存档位置迁移与首次进入维护。
- Context：立项时基于 3.1.11 诊断；当前实施基线的 `package.json` 已预置 3.1.12，且用户已确认 TechDoc。
- Constraints：历史 VCC 不处理；未知文件不删除；安全恢复屏障保留；不实现 WAL 设置；资金与文件完整性 fail-closed。
- Done when：TechDoc 评审通过后，代码、测试、Windows 性能门禁和 VCC 人工复核全部闭合。

## 已确认事实

| 事实 | 代码证据 | 对方案的约束 |
| --- | --- | --- |
| 网银 freshness guard 有多个调用点 | `src/main.js` 的 selection、preflight、big-account prepare/complete/order 路径 | 必须删除调用点而非只缓存 stat 结果 |
| source snapshot 已有 size/mtime/ctime/ino 比较 | `src/main-process/archive-center/source-snapshot.js` | 复用合同，补 Windows inode 精度 |
| `beforeStart` 位于 File Batch 预留后、业务 execute 前 | `src/main-process/archive-center/task-lifecycle.js` | 变化失败无业务副作用，但保留 failed task/batch 审计 |
| eager File Task 在 beforeStart 前已有一次 `assertFilePlanFresh` | `task-lifecycle.js` + `file-plan.js` | 网银不得再加专用 comparison；应让公共 FilePlan 继承 picker snapshot |
| 大账号顺序当前会重新读取源文件 | `buildBigAccountOrderData`、`file:extract-big-account-order` | 预检必须冻结最小账号证据 |
| 数据库每次启动执行无参数 ANALYZE | `src/backend/database.js` | 改为 exact `PRAGMA optimize=0x10002` |
| 窗口默认先于初始化创建 | `src/main.js` 的 `DEFERRED_WINDOW_STARTUP`；renderer `initPending` | 改为单一完整态窗口时序 |
| VCC lineage 目前启动执行两次 | Archive post-outbox hook + `runBackgroundInitChain()` 显式调用 | 只保留 post-outbox 一次 |
| VCC system snapshots 缺 import_source_id 索引 | storage contract 只为 fallback/effective 建 source 索引 | 新增 partial index并改集合计数 |
| VCC rawJson 在业务规范前形成 | row mapper/system importer | 可保留 CNH 原文并单独计算规范哈希 |
| 系统 OP 已按主体隔离 validation error | `rowsBySubject` + per-subject try/catch | CNY+CNH 可只拒绝当前主体 |
| 根迁移已有 journal/copy/verify/switch/cleanup | `storage-root-manager.js` | 保留状态机，不降级为只改路径 |
| root startup 会先加载全 evidence | `_prepareActiveRoot()` 调 `_evidence()` | 固定关键路径与完整 evidence 解耦 |
| 通用 orphan scan 可删除 DB 外 SHA 文件 | Archive service orphan prefix scan | 收紧为 durable ownership evidence |

## Unknowns Register

| 未知 | 分类 | 影响 | 取证/决定 | 状态 |
| --- | --- | --- | --- | --- |
| freshness 最终点是否在业务副作用前 | PROBE | 高 | TaskLifecycle 证明 beforeStart 在 execute 前 | CLOSED |
| 公共 FilePlan freshness 是否会造成第二次比较 | PROBE | 高 | 已确认会；改为 picker snapshot 注入公共 FilePlan，beforeStart 只验 session | CLOSED，TechDoc 已反向同步 |
| freshness 失败是否完全不留 DB 记录 | PROBE | 中 | 会保留 failed task/batch；Spec 已显式写明 | CLOSED |
| 大账号顺序能否不重读源文件 | PROBE | 高 | preview 已持有解析结果，可冻结最小识别证据 | CLOSED |
| VCC 哪些币种字段实际参与金额 | PROBE | 高/资金 | 已逐分支核对 row mapper 与 system importer | CLOSED |
| 新 hash 如何兼容旧记录 | PROBE | 高/幂等 | CNY 原文不改；只将 CNH token 投影为同位置 CNY；不复用现有 legacy_content_hash | CLOSED，边界见 TechDoc D-06～D-08 |
| 系统 CNY+CNH 是否能只拒绝一个主体 | PROBE | 高/资金 | 现有 per-subject accumulation 支持 | CLOSED |
| 存档地址变更是否已经迁移数据 | PROBE | 高/文件 | 现有 root manager 是迁移状态机 | CLOSED |
| 指纹如何避免 Windows inode 精度丢失 | ASSUME/设计 | 中 | inode 存十进制 TEXT；不可得时省略 | CLOSED（TechDoc 已确认；PR1 已先完成 source snapshot 无损 token） |
| 旧存档被新引用是否顺手补指纹 | 产品边界 | 中 | 严格不补，旧 Blob NULL 保持 | CLOSED（用户“不补建”口径） |
| cleanup-pending 是否应阻塞启动删除旧根 | 设计 | 中/性能 | 权威根已切换时延到首次进入；前切换阶段仍阻塞恢复 | CLOSED（TechDoc 已确认） |
| retention 前是否再次全量 VCC reconcile | 安全/性能 | 高 | 不重复；只做 outbox/active/hold 轻门禁，异常停止删除 | CLOSED（TechDoc 已确认） |
| 2.9GB 样本首要耗时能否在本机复现 | PROBE | 中 | 当前仅有用户提供诊断；实施后 Windows 阶段日志/对拍验证 | OPEN-RUNTIME，不阻塞设计 |
| 70% 指标是否实际达到 | PROBE | 发布 | 必须 packaged 5 次中位数验证 | OPEN-RELEASE-GATE |

## 风险优先实施计划

| 顺序 | 步骤 | 保护的不变量 | 成功证据 | 失败时收缩 |
| --- | --- | --- | --- | --- |
| 1 | 先写 seam/red tests，收敛网银唯一确认点 | 变化后不执行业务；其他 SHA 不删 | comparator=1、execute=0 | 只回退该调用重构 |
| 2 | VCC 单来源 canonical hash 纵切 | 金额、币种、审计、幂等 | row mapper/importer focused tests | 不进入其他来源 |
| 3 | 覆盖系统 OP/Pending/全部通道分支 | 主体隔离、九币种、行数守恒 | 资金专项测试与人工样本 | 阻断 VCC 合并 |
| 4 | 建启动阶段日志并替换 ANALYZE | 可解释性能、不吞初始化失败 | exact SQL + phase tests | 可单独回退 optimize 改动 |
| 5 | 删除重复 VCC 与两阶段窗口 | 一次安全门禁、无半初始化 UI | startup failure/ordering tests | 保留原生错误路径 |
| 6 | Archive additive schema + fingerprint | 历史 NULL、SHA 真相 | repository/service matrix | nullable schema 可兼容回退 |
| 7 | 拆 startup/entry maintenance，收紧 orphan | 不越根、不误删、启动减量 | controller/root/orphan fault tests | retention/cleanup fail-closed |
| 8 | UI、全仓、Windows 与人工门禁 | 产品验收与发布安全 | release-check/perf/资金签字 | 不发布 v3.1.12 |

## 当前门禁

- 无未公开的产品 BLOCK。
- TechDoc D-01～D-20 已由用户整体确认；`v3.1.12` 集成分支已从最新 `origin/main` 建立。
- 运行期性能与 Windows 结果属于实施后的 PROBE/发布门禁，不能在 TechDoc 阶段伪造结论。
- VCC 属于资金红线，自动测试通过也必须人工复核。
