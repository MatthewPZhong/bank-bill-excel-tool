# 实施预检

## Task Brief

- Goal：统一存档中心永久删除，真实完成受管文件清理，并提供可恢复的失败状态。
- Context：[spec.md](spec.md)、[techdoc.md](techdoc.md)。用户已确认 D-01 managed-only。
- Constraints：保护运行、锁定、业务引用、恢复/迁移和 owner 终态；不删除外部源文件或业务数据；不提交、推送、升版。
- Done when：必要实现与真实临时文件/SQLite 回归通过，适用验收及剩余人工检查如实记录。

## 已确认事实

| 事实 | 证据 |
| --- | --- |
| 基线 v3.2.8，独立工作树 | `git branch --show-current`，baseline `2ba9ef14fe972363b604955636cff0c9ac53700f` |
| 主工作树包含无关修改，必须隔离 | 主目录 git status；本轮 worktree `/Users/pzhong/Desktop/Project/bank-bill-excel-tool-worktrees/codex-v3.2.9-archive-center-permanent-delete` |
| 既有清理 job 仅路径数组，失败可丢失 UI 入口 | archive-repository.js deleteBatch；archive-service.js _executeCleanupJobUnlocked；renderer.js confirmArchiveBatchDelete |
| 迁移 journal 可在维护锁释放后存留 | storage-root-manager.js _finishCleanup/changeStorageLocation |
| file-batch outbox 仍会调用 finishFileTask | controller.js _flushOutboxUnlocked |

## Unknowns Register

| ID | 类型 | 问题/决定 | 状态/证据 |
| --- | --- | --- | --- |
| D-01 | BLOCK → 已关闭 | 外部导入原文件范围 | 用户确认仅受管文件，已同步 Spec |
| P-01 | PROBE | 持久计划、重试、完成凭证与损坏格式保护 | Repository 实现和 SQLite 回归 |
| P-02 | PROBE | 迁移与 owner/outbox 收口交叠 | 定向生命周期回归 |
| P-03 | PROBE | 受管对象身份和只读副本归属 | 实际文件 IO、替换/离线/共享回归 |
| A-01 | ASSUME | 发布版本号不变 | 模块分支保留 package 3.2.8，发布阶段升版 |

## 风险优先计划

1. 先固定归属及根/对象身份，再落持久计划和逐项状态；损坏格式保持可诊断，不当空计划。
2. 保留元数据事务、发行/owner 防重放事实；验证提交失败及完成响应丢失。
3. 接入 readonly 预检、受绑定确认、等待本次清理、独立任务列表与重试。
4. 完成迁移历史交叠恢复与全链路临时数据库/文件验收；不对真实用户数据试删。
