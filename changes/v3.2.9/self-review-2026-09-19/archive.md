# v3.2.9 存档永久删除与模块保留期限只读审查

审查日期：2026-09-19。冻结候选：`/private/tmp/v329-release-20260919-3_bafjvz/review-snapshot`，HEAD `6bd55efe0eb1d90c16cd92f3a78e54a39a36b966`，叠加原有 18 项外观相关工作区改动。审查对象为该内容组合，不把历史分支门禁当作本次组合门禁。

并行 UI 验证随后生成 `live-runtime.json` 及两张 live 截图，当前状态已另存为 [snapshot-status.txt](/private/tmp/v329-release-20260919-3_bafjvz/archive-review/snapshot-status.txt)；这些新增证据不属于原 18 项改动，本子任务未修改 snapshot。

结论：本次未发现或复现 P0/P1/P2；发现 1 项 P3 文档状态漂移。新增 6 个独立跨层探针全部通过。此结论覆盖下述删除/保留期限范围；正式发布门禁及平台人工验收由总审查单独汇总。

## 范围与方法

- 已读候选 `AGENTS.md`、`CODEX.md`，以及永久删除、模块保留期限两项 Spec/TechDoc 与对应验证记录。
- 检查 Renderer/IPC → Controller → Service → SQLite Repository，以及 TaskLifecycle owner completion、持久删除计划、Position 受管来源适配器、Main 服务工厂与存储根迁移的交叉边界。
- 核对 18 项外观改动叠加后的 `src/renderer.js`：期限队列、设置加载、删除预检返回后的二次检查、弹窗销毁与迟到请求隔离。临时移走/恢复设置 overlay 不等于销毁，未据此认定主题保存丢失。
- 未修改冻结候选、生产源码或业务数据。新探针仅使用本报告目录下的临时 SQLite/文件，结束后清理；保留探针源码和日志。未在本子任务重复运行完整 release-check。

## Findings

### P3 — 永久删除文档的实施状态与集成分支漂移

定位：

- [spec.md:8](../codex/v3.2.9-archive-center-permanent-delete/spec.md#L8)、243、247–252 行仍使用 `release/3.2.9`；实际集成分支为 `release/v3.2.9`。
- [spec.md:239](../codex/v3.2.9-archive-center-permanent-delete/spec.md#L239)、271–277 行仍称新功能未实施、实现/测试未执行，与顶部第 10/14 行及实际代码状态不一致。
- [techdoc.md:9](../codex/v3.2.9-archive-center-permanent-delete/techdoc.md#L9)、546/562 行沿用旧分支名；第 15 行“未提交”已不适用于当前组合。

触发与复现：按 Spec 的当前状态表核对冻结候选 HEAD、实际永久删除实现及既有 validation.md，即可同时得到“已完成实现”和“未实施”两种互斥状态；按其集成说明操作会选用错误分支名。影响为发布交接和证据归属，未发现运行时影响。

建议：只同步当前集成分支及实施状态；把基线诊断/早期命令明确标为历史记录，链接对应历史证据和最终组合验证。Windows、真实文件占用、安装包和人工验收仍保留未执行，不能由文档整理改成通过。

## 新增独立复现探针

[探针源码](probes/archive-independent.js)，[本次日志](archive-probes.txt)。命令：在本报告目录运行 `node independent-probes.js`。退出码 0，6/6 PASS。

| 编号 | 主动制造的状态/竞态 | 实际结果 |
| --- | --- | --- |
| P-01 | 原窗口 sender 7 预检，sender 8 使用同一确认 token，再由原窗口提交 | 错误窗口被拒绝；原窗口完整删除；外部原文件内容保留 |
| P-02 | 预检后把目录化文件改名，原路径创建同内容的新 inode | 返回 `ARCHIVE_DELETE_FILE_CHANGED`；批次和替代文件均保留 |
| P-03 | 预检后新增真实只读副本，再用旧 token 提交 | 返回 `ARCHIVE_DELETE_CONFIRMATION_STALE`；重新预检后完成清理，已登记副本/存档/Blob 全部清除，外部源保留 |
| P-04 | 对目录化文件注入 EBUSY，元数据删除后创建新的同内容批次，再重试旧清理任务 | 旧任务不破坏新批次文件/Blob；最终删除新批次后独占 Blob 可清理 |
| P-05 | 部分删除后同路径替换文件，关闭并重开真实 SQLite 和服务，再重试 | 原持久计划仍返回文件身份冲突；替代对象和外部源保留，任务不假完成 |
| P-06 | Main 同款 runtime delegate/manager/service 工厂，在维护租约内分别传错误/正确 token；30 天批次创建后把模块改永久 | 错 token 被维护门禁拒绝；正确 token 仅清理旧到期快照，永久批次/外部源保留；原批次日期未被配置变化追溯改写 |

P-04 的初始扩展还尝试同时阻断旧 Blob 和目录化文件，再发布相同内容；服务安全拒绝 `ARCHIVE_BLOB_UNKNOWN_CONFLICT`，没有认领仅存在于磁盘、缺少当前引用证明的 Blob。这不是产品失败。原诊断日志保存在 [independent-probes-initial-existing-blob.log](/private/tmp/v329-release-20260919-3_bafjvz/archive-review/independent-probes-initial-existing-blob.log)。

边界：P-05 是同进程内真实数据库/服务重开，不冒充强杀 Electron 后冷启动；P-04/P-05 的 EBUSY 为受控故障注入，不冒充 Windows 真实占用测试。

## 永久删除需求验证矩阵

“本次探针通过”仅指上表实测；“源码核对”表示已检查对应约束和现有回归入口，不声称本轮重新执行该测试。最终全量门禁需要引用总审查的最终内容结果。

| Spec | 本次核对结果 | 证据/仍需补充 |
| --- | --- | --- |
| REQ-01/03、AT-01 | 删除走统一入口，文案与 managed-only 范围一致，没有仅工具箱条件 | Renderer `confirmArchiveBatchDelete()`；实际普通模块/工具箱 GUI 操作待验 |
| AT-02/15/16 | 确认前预检只读；token 绑定调用者；提交结果严格区分完成/部分失败；列表请求失效处理存在 | P-01；`archive-delete-dialog-lifecycle.test.js` 覆盖取消、重复提交、迟到响应；当前交互实测由 UI/总审查汇总 |
| REQ-02、AT-03/04/19 | 计划枚举全部 artifact、Blob 和已登记临时对象；完整完成依赖所有清理项收口 | P-01/P-03；`batch-delete-plan.js:150`、`controller.js:1657`；多输入/输出及失败/取消批次有现有回归 |
| AT-05/24 | 不把外部 `sourcePath` 当删除授权；Position 仅认持久原归属证据 | P-01～P-06 的外部文件内容保持；`position-owned-delete-sources.js:115/311` |
| AT-06/22 | 重试重新验证当前 Blob 引用与身份；不使用旧释放清单盲删 | P-04；`batch-delete-plan.js:351` |
| AT-07/23 | 活动、锁、业务 hold、恢复 overlay 和原 owner 未收口阻止删除；不级联删除模块业务数据库 | `batch-delete-plan.js`、`controller.js:1523/1573`、Repository 删除事务；现有 permanent-delete/module-retention 集成包含负例 |
| AT-08 | 物理失败保留持久任务，不能返回完整成功 | P-04/P-05；Windows 真实占用及权限失败待平台验收 |
| AT-09 | 同内容不同对象不能冒充原对象；持久重试仍使用原计划身份 | P-02/P-05；`captureFileIdentity()` 与 unlink 前同步复核 |
| AT-10/11 | 缺失对象、根身份/父目录、路径穿越、链接按 fail-closed 路径区分处理 | `batch-delete-plan.js:31/41/65/351`；真实离线介质和 Windows junction 仍需平台复核 |
| AT-12 | 元数据删除、引用释放、持久计划在同一 SQLite 写事务；清理在提交后执行 | `archive-repository.js:4896`；现有真实 DB 故障测试入口，不把本次普通成功当提交失败证明 |
| AT-13 | 部分状态重开后保留原身份和剩余清理责任；无批次复活 | P-05；真正进程退出/安装包冷启动尚非本子任务证据 |
| AT-14 | 原生命周期写完整 owner 完成凭证；预检、事务前重校验与迟到通知都检查身份/终态/后处理 | P-01～P-06 都经真实 TaskLifecycle 完成；`task-lifecycle.js:222`、`controller.js:1523`；完整反例入口为 `archive-delete-owner-completion.test.js` / `archive-file-owner-recovery.test.js` |
| AT-17 | 自动清理沿用 managed-only，维护 owner token 正确传递 | P-06；`main.js:4936/4943` |
| AT-18 | 未收口迁移 journal 独立于临时锁阻止新删除；既有重叠计划按 waiting-migration 协议恢复 | `storage-root-manager.js:362` 及迁移/删除恢复路径；现有 `archive-storage-root-migration.test.js` 包含阶段故障，需总门禁确认当前通过 |
| AT-20 | 只读副本必须有持久创建/完成身份；预分配路径不代表删除授权 | P-03；原 fd/父目录校验与 ready 登记流程、计划 constructing/ready 分支均有对应保护 |
| AT-21 | 旧计划不能凭当前文件状态认领现存对象；无原身份的 legacy 任务保留诊断 | `upgradeLegacyDeletePlan()`；本次未把历史 unknown 数据自动补成可删 |

## 模块期限需求验证矩阵

| Spec 验收 | 本次核对结果 | 证据/边界 |
| --- | --- | --- |
| 1：14 模块、独立持久化/重读 | canonical module 注册表、独立 map 与动态读取保留，模块设置不覆盖默认值 | `retention-policy.js`；既有 policy 与真实 SQLite 集成入口，未把静态检查等同当前 14 项逐项重测 |
| 2：继承/永久/非法输入 | 缺 key 为继承，null 为永久，inherit 删除 key；非法写入先校验 | `retention-policy.js:42/51`；别名沿用 scope registry，未知旧批次无 override 时回退默认 |
| 3：全部创建链与显式期限优先 | Main 工厂保留动态 resolver；Service 普通创建、TaskBatch、reserve 共用解析；显式值和已存在批次优先 | `main.js:4936`、`archive-service.js:1163`；P-06 实测真实 TaskLifecycle 与工厂重建组合 |
| 4：历史/幂等快照不回写 | 配置变更不更新既存批次日期；旧 outbox payload 记录当时配置 | P-06；源码核对优先级，现有 module-retention 集成覆盖复用 |
| 5：真实清理与保护 | 仅清理已过期且可删除的原快照，永久保留，维护自身租约不自阻塞 | P-06；现有 module-retention 集成含到期日边界、锁定、业务 hold、legacy 无 proof 拒绝 |
| 6：保存/失败/关闭/尺寸缩放 | latest-intent 队列带 moduleId；loading/saving/pending 在预检前后均检查；销毁后迟到响应失效 | `renderer.js:3378–3515/3728/3764/3832`；当前 6 组尺寸/缩放 Electron DOM 结果与真实 GUI 由总审查补齐 |

## 最终交付必须区分的证据

1. **强制自动门禁**：最终整合内容的 `npm run release-check`，以本轮真实日志、最终 commit/工作区边界和计数为准。历史 validation/verification 中的 PASS 不是最终发布候选的证明。
2. **平台验收，当前本子任务无证据**：Windows 真实文件占用、ACL/权限不足、存储盘离线/连接恢复、目录联接；文件系统身份字段必须在实际支持平台可用。
3. **人工 GUI/安装包验收，当前本子任务无证据**：普通业务模块、工具箱、业务引用保护批次；取消零副作用；完整删除后实际文件/数据库核对；占用失败后解除占用、退出重开并重试；managed-only 原件/用户另存副本保留。使用专用测试数据。
4. **期限 UI 当前内容证据**：1080×760 / 1240×860，100% / 125% / 150%，快速连续修改、失败回滚、保存期关闭保护、删除预检跨保存窗口。可用实际 Electron DOM 自动记录补充；不得将截图当完整行为验收。

本报告及探针不发布、不提交、不操作真实存档。后续 P3 文档修正与最终门禁结果由总审查记录，不能倒写为本冻结快照已经包含这些修正。

## P3 后续修正记录

完成上述只读审查后，按总任务追加授权和项目 save-spec Skill，仅修正真实 `release/v3.2.9` 工作树内永久删除 `spec.md` / `techdoc.md` 的分支名、当前实施/集成状态，以及历史设计/证据标识。业务合同、删除范围、验收条件、原历史验证记录均保留，Windows/GUI 明确 `NOT_RUN`；最终组合门禁和发布状态链接整版 `release.md`，未提前宣告通过。

文档差异为 2 文件，32 行新增、29 行删除；`git diff --check`、相对文件链接存在性、旧分支名移除及 NOT_RUN 保留检查通过。未 stage 或 commit。修正位于真实 release 工作树，冻结快照中的 P3 原始证据仍保留。


> 本报告保留审查快照时的结论。后续文档修复及最终组合验证以 [总审查](../release-review-2026-09-19.md) 和 [发布记录](../release.md) 为准。
