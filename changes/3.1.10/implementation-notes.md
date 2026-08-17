# Implementation Notes — v3.1.10 VCC storage compaction

## Baseline

- Goal/spec: `changes/3.1.10/spec.md`
- Initial plan: schema/import → archive binding/hold → export/UI → maintenance migration → regression/perf/manual gates.
- Done when: 运行时与迁移均满足 Spec，真实库目标和资金人工复核通过后才可发布。

## Decisions

| 决定 | 原因与证据 | 放弃的方案 | 影响 |
| --- | --- | --- | --- |
| 已发布3.1.6/3.1.8文档保持冻结，3.1.10前向取代 | 发布审计不可追溯改写 | 修改旧Spec | 旧库只经显式迁移进入新合同 |
| artifact是长期原件，fallback仅覆盖新导入未归档窗口 | Archive已有SHA Blob；用户明确历史不补fallback | SQLite永久raw_json | 降低SQLite体积，保留业务成功/存档失败可用性 |
| pure idempotent skip和正常rollback不留逐行审计 | 用户明确只保存真正异常 | 永久逐行audit | record计数仍守恒；文件级失败一条事件 |
| 历史缺口允许部分导出但必须显式不完整 | 用户确认 | 整体拒绝或伪造完整 | 二次确认+说明sheet+missing汇总 |
| business hold独立于用户锁 | retention/manual delete不得绕过有效事实引用 | 自动toggle locked | 任一hold阻断批次删除 |
| 维护迁移采用copy-on-write，旧库是否自动删除由用户显式勾选 | 用户原合同要求首次只读校验后按选择处理旧库 | 原地ALTER/DELETE/VACUUM、无确认自动删 | journal+守恒+reopen校验后才可按选择删除旧库 |
| v1物理库允许承载v3.1.10过渡期写入 | 用户必须显式选择物理重建，不能因升级自动停服 | 启动即迁移或升级后禁止导入 | 新导入先获得source/anomaly/fallback合同；COW保留未归档fallback |
| 候选库和切换前新旧主文件必须显式fsync | 候选复制为吞吐使用synchronous=OFF，close不等于断电耐久 | 只依赖rename/close | 候选文件与目录落盘后才进入切换journal；公共切换边界再次落盘新旧主文件 |
| VCC 终态输入优先使用运行时 exact descriptor 进入 Archive | 失败文件同样是异常审计与重试的原始证据；只登记成功组会让失败 source 永久不可绑定 | 继续沿用 PR3 仅成功组筛选 | 有 SHA/size descriptor 时登记成功与失败全部输入；无 descriptor 的旧调用保留成功组兼容 |
| 迁移 worker 复用共享错误序列化协议 | 第二套简化协议会丢 cause/context/detailLines | 迁移专用四字段 error DTO | 与其他 worker 一致保留错误链和结构化定位证据 |
| contract-v2 采用 connection-local capability + exact triggers 阻断降级写 | v3.1.9 不认识 app setting marker，且 SYSTEM_OP 可绕过 slim detail schema 继续写 | 只依赖 marker 或删列自然报错 | 23 张 VCC 表的 I/U/D 都要求新版连接显式注册；marker+guards 原子安装，mutation guard 只接受 exact name/table/SQL |
| VCC 输入在业务开始前持久化 immutable Archive handoff | 业务终态与首次 settle 间崩溃会丢完整原件接管证据 | 只依赖内存 runtime descriptor 或业务后归档 | 原 task batch 保存 exact7+path/type/ordinal/SHA/size；worker 首次 hash 后、首写前精确复核，崩溃可由 startup owner 重放 |
| 已 ready artifact 复用也必须匹配本次 expected SHA/size | 同路径在 handoff 后被替换会把 A artifact 错配给 B 业务 | 沿用 path/artifactKey 的 `alreadyArchived` 快路径 | 冲突明确 fail-closed且不覆盖既有 Blob；业务 DML 为 0 |
| 迁移使用 owner/token lease 与 worker ready/ack 锁交接 | 无 owner transition 可互相释放；候选复验后提前释放源锁会吞掉切换前成功写 | UI 约束或 boolean transition | updater/exit/migration 只释放自己的 lease；主库关闭后才 ack worker 释放 `BEGIN IMMEDIATE` |
| Archive startup 在 retention 前完成 VCC lineage/hold reconcile | ready artifact 与 hold 之间崩溃后，过期清理可先删唯一原件 | 常规启动后异步 sync | 固定 outbox→owners→post replay→VCC hook→sweep/retention；hook 失败阻断 cleanup/admission |
| bound detail、SYSTEM_OP 与 v1 统一走实体完整性 gate | 本地 `raw_json` 不能掩盖已绑定 artifact 损坏 | SYSTEM_OP/v1 永久绕过 Archive verification | 只有从未有 source 的历史 v1 可走过渡 raw；其余实体故障整次失败 |
| Windows 数据库文件 fsync 使用可写句柄，PR checkout 保留冻结 tag | Windows `FlushFileBuffers` 对只读文件句柄返回 `EPERM`；v3.1.9 兼容探针必须读取发布 tag | 忽略文件 fsync 或在测试内联网 fetch | 不放宽断电耐久门禁；Windows 候选/切换文件可落盘，CI 可离线加载冻结历史实现 |
| 同批同键冲突持久化对端 staging 哈希与逐字段差异 | compact anomaly 若只关联 effective，会让两个首次出现的冲突行都缺 existing hash | 只写通用“业务内容”或保存完整 raw | 异常导出可双侧核对，仍不永久保存完整原始行 |
| SYSTEM_OP 未绑定原件时以 snapshot raw 作为临时 fallback | 新导入业务成功后，Archive pending/failed 窗口仍须满足“尚未归档可完整导出” | 将九币种误计为历史缺口或放宽已绑定故障 | 从未绑定时完整导出；一旦有 artifact/bound 证据仍整次失败关闭 |

## Assumptions

| 假设 | 依据 | 失效影响 | 验证与回滚 |
| --- | --- | --- | --- |
| `source_type+idempotency_key+content_hash` 足以校验重建行身份 | 当前幂等与内容hash合同 | 原表定位错误 | 读取时再核sheet/row/hash；任一错整次失败 |
| 对同一artifact的任一有效引用可提升为批次级删除阻断 | 当前删除API是batch级 | 粒度过粗但不丢数据 | UI明确业务锁；未来可另立artifact级删除 |
| 历史binder可以从flow anchor与artifact metadata获得部分exact证据 | PR3 Archive identity已持久化 | 覆盖率低 | 不猜；保留unavailable并部分导出 |

## Deviations

| 原计划 | 实际方案 | 原因 | 影响 | Spec 已同步 |
| --- | --- | --- | --- | --- |
| 初稿写成成功后无条件自动删除旧库 | 确认框提供“校验成功后删除旧数据库”选项；未勾选保留 migration-id 备份 | 用户原计划明确要求“按用户选择”；无条件删除扩大不可逆范围 | 默认更保守，可能额外占用磁盘；UI明确提示 | 是，Spec §6.4 |

## Evidence

| 证据 | 结果 | 覆盖的行为/风险 |
| --- | --- | --- |
| Git基线与worktree | `646bcf4`，tracked clean，用户untracked保留 | 实施起点/ownership |
| 生产库只读dbstat | VCC核心约27.42GB；slim投影约4.3–4.6GB | 物理迁移必要性与目标 |
| 现有调用图审计 | importer永久写import_rows/raw_json；Archive持有SHA Blob；delete为batch级 | 纵切接缝与hold边界 |
| COW真实SQLite故障矩阵 | 候选构建、非VCC源行、文件级失败去重、空间/计数失败、AUTOINCREMENT、exact binder、fallback/hold、fsync、rename前后恢复共11/11 PASS | 旧库唯一真相、非VCC/过渡数据守恒与断电切换边界 |
| slim schema 生产回归 | detail import/幂等重放、calculate+九币种余额+archive、source destructive delete 均在真实 slim effective schema 下 PASS | 移除 raw_json/source_file 后无旧列旁路 |
| Archive lineage 聚焦 | 终态成功/失败输入 exact SHA/size、ready 绑定清 fallback、business hold、损坏/删除后的 unavailable 状态共25/25 PASS | 原件血缘、失败文件归档与删除状态同步 |
| 扩大 v3.1.10 聚焦 | 313/313 PASS | schema/import/system/hold/export/migration/UI 与既有资金主链 |
| 共享 worker 错误协议回归 | serialize-error + migration coordinator/rebuild 33/33 PASS | stack/cause/context/detailLines 与迁移故障可观测性 |
| 静态门禁 | `npm run lint`、全部 changed/new JS `node --check`、`git diff --check` PASS | 代码质量与可加载性 |
| check-vars | exit 2 review：Important `ipcRenderer/serializeError/setupIdleCleanupTimer`；Runtime `app/dialog/setStatus/state`；无 Critical/Risk-sensitive | IPC 双端同步；错误协议复用；维护暂停后仅恢复既有 idle timer；原生确认取消、relaunch 与 UI 状态生命周期均有聚焦/full 证据 |
| 完整 release-check | lint/smoke PASS；unit 5165/5165（336 files）；integration 48/48 scripts、2385/2385 assertions（369164ms） | 全仓回归；runner 仅全绿后自动同步 integration policy |
| 首轮独立 Ultra Review | 322/322 focused；确认 5×P1、4×P2，剔除 ready 后双份同大小物理篡改等过度防御候选 | COW 锁/transition/downgrade/durable handoff/export完整性/legacy recovery/retention/source identity/fsync |
| Review findings 开发修复 | migration 核心28/28+相邻104/104；contract/recovery 116/116+mutation32/32+异常5/5；archive focused71/71+相邻219/219；unit5187/5187 | 九条真实生产 finding 全部 Red→Green，未放宽业务或完整性合同 |
| 修后交叉竞态 | 真实双 XLSX A→B 先红后绿；focused124/124、adjacent113/113、Archive31/31、unit5191/5191 | handoff descriptor 贯穿 worker 首写前；ready artifact expected mismatch 明确拒绝 |
| 最终独立 Ultra Review | PASS；原九条及 A→B 反例均独立重放关闭，最终相关198/198；无 surviving P0–P3 | 达到本地 review 合并标准，未访问生产 DB |
| 修后最终 release-check | lint/smoke PASS；unit 5191/5191（336 files）；integration 48/48 scripts、2385/2385 assertions（368077ms） | 九条 review fix 与 A→B 时序修复合并后的全仓终态；runner 仅在全绿后刷新 policy |
| 修后最终 check-vars | exit 2 review：Critical `freezeWorkerBatchContext`；Important `ipcRenderer/serializeError/setupIdleCleanupTimer`；Runtime `app/dialog/setStatus/state`；Risk `ArchiveRepository` | exact7 字段未增删且 descriptor 单独冻结；IPC 双端同步；共享错误协议不变；idle timer 只暂停/恢复；退出/更新 lease 精确 owner/token；Archive hold/outbox/Blob SHA+size 身份保持。Critical/Risk 要求的 smoke 已在最终 release-check 通过 |
| PR #147 首次 Windows CI | release-check 5171/5191；2 项因 shallow checkout 无 `v3.1.9` tag，17 项因 Windows 只读句柄 `fsync` 返回 `EPERM` | CI 首次提供真实 Windows 句柄语义；修复为 smoke checkout `fetch-depth: 0` 与文件 `r+` fsync，目录 fsync 既有明确 errno 容错不变 |
| PR #147 CI 修复本地复验 | 聚焦 68/68；完整 release-check lint/smoke、unit 5191/5191、integration 48/48 scripts 与 2385/2385 assertions（395255ms）PASS；node/diff/check-vars 收口 | 保持同一耐久与历史兼容合同，等待同一 Windows workflow 远端复验 |
| PR #147 首轮 review 两项 P2 | 两项先红 47/49，再修后 detail/system/rebuild 相关 91/91 PASS；最终 release-check lint/smoke、unit 5193/5193、integration 48/48 与 2385/2385（305367ms）PASS | contract-v2 同批冲突保存 peer hash+精确 diff；SYSTEM_OP pending/failed 且从未绑定时以 raw fallback 完整导出，bound 故障门禁不放宽 |

## Remaining Unknowns

| 未知 | 处理 | 负责人/下一步 | 合并影响 |
| --- | --- | --- | --- |
| Windows SQLite切换、WAL与文件占用 | PROBE | packaged installer/portable手工验证 | 未通过阻断发布 |
| 真实历史exact binder覆盖率 | PROBE | 只读副本报告 | 不影响安全；影响部分导出比例 |
| 真实库迁移后dbstat/耗时/空间 | PROBE | 用户副本维护迁移 | 未达75%阻断发布 |
| 主体×九币种资金事实 | BLOCK-at-release | 财务人工复核 | 未签字阻断发布 |
